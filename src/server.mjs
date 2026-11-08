#!/usr/bin/env node
/**
 * 本地模型中转网关（LLM Gateway）
 * 零依赖，Node >= 18（推荐 20+）
 *
 * 用法：
 *   node src/server.mjs --config config.json [--port 8787] [--host 127.0.0.1] [--data ./data]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadConfig, buildIndex } from './config.mjs';
import { Store } from './store.mjs';
import { createLimiter } from './ratelimit.mjs';
import { authenticate, checkQuota, modelAllowed, allPeriodKeys } from './auth.mjs';
import { computeCost, estimateTokens, normalizeUsage, resolvePrice } from './metering.mjs';
import { forward, routeProvider } from './proxy.mjs';
import { createAdmin } from './admin.mjs';
import { createBridgeSupervisor } from './bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`本地模型中转网关
  --config, -c <file>   配置文件路径（默认 ./config.json）
  --port,   -p <port>   监听端口（默认取配置）
  --host    <host>      监听地址（默认取配置）
  --data    <dir>       数据目录（台账/快照，默认 ./data）
环境变量：GW_CONFIG / GW_HOST / GW_PORT / GW_ADMIN_TOKEN`);
  process.exit(0);
}

const configPath = path.resolve(args.config ?? process.env.GW_CONFIG ?? path.join(ROOT, 'config.json'));
const dataDir = path.resolve(args.data ?? path.join(ROOT, 'data'));
const runtimePath = path.join(dataDir, 'clients.runtime.json');

/* ---------------- 初始化 ---------------- */
const store = new Store(dataDir);
store.init();
const limiter = createLimiter();
const startedAt = Date.now();

const ctx = {
  cfg: null,
  byHash: null,
  configPath,
  store,
  limiter,
  startedAt,
  reload,
};

function applyRuntime(cfg) {
  if (!fs.existsSync(runtimePath)) return 0;
  try {
    const extra = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    let n = 0;
    for (const c of extra.clients ?? []) {
      if (cfg.clients.some((x) => x.id === c.id)) continue;
      c._runtime = true;
      cfg.clients.push(c);
      n++;
    }
    return n;
  } catch (e) {
    console.warn(`[config] 运行时客户端文件损坏，已忽略: ${e.message}`);
    return 0;
  }
}

function saveRuntime(c) {
  const list = c.cfg.clients
    .filter((x) => x._runtime)
    .map(({ _hash, _runtime, ...rest }) => rest);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = runtimePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ clients: list }, null, 2), 'utf8');
  fs.renameSync(tmp, runtimePath);
}

function reload() {
  try {
    const { cfg } = loadConfig(configPath);
    if (args.port) cfg.server.port = args.port;
    if (args.host) cfg.server.host = args.host;
    const n = applyRuntime(cfg);
    const byHash = buildIndex(cfg);
    ctx.cfg = cfg;
    ctx.byHash = byHash;
    console.log(`[config] 已重载 ${configPath}（运行时客户端 ${n} 个）`);
    return { clients: cfg.clients.length, runtimeClients: n };
  } catch (e) {
    console.error(`[config] 重载失败: ${e.message}`);
    return { error: e.message };
  }
}

(function boot() {
  const { cfg, byHash } = loadConfig(configPath);
  if (args.port) cfg.server.port = args.port;
  if (args.host) cfg.server.host = args.host;
  const n = applyRuntime(cfg);
  ctx.cfg = cfg;
  ctx.byHash = buildIndex(cfg);
  if (n) console.log(`[config] 叠加运行时客户端 ${n} 个`);
})();

/* ---------------- 工具 ---------------- */
function sendJson(res, code, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extra,
  });
  res.end(body);
}

function sendApiError(res, code, message, type = 'gateway_error', extra = {}) {
  sendJson(res, code, { error: { message, type, code: type } }, extra);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '-';
}

function reqId() {
  return 'gw_' + crypto.randomBytes(6).toString('hex');
}

function logLine(e) {
  const tok = `${e.tokensIn}/${e.tokensOut}`;
  const flag = e.status >= 400 ? '!!' : 'ok';
  const hhmmss = new Date(e.ts).toTimeString().slice(0, 8);
  console.log(
    `[${flag}] ${hhmmss} ${e.clientId} ${e.model ?? '-'} ${e.status} ${tok}t ${e.latencyMs}ms ${
      e.stream ? 'stream' : 'sync'
    } ${e.reqId}${e.err ? ' err=' + e.err : ''}`,
  );
}

/* ---------------- 主处理 ---------------- */
const extraHeadersFor = (q, c) => {
  const h = {};
  if (q) {
    h['x-gw-quota-period'] = q.period;
    h['x-gw-quota-tokens-used'] = String(q.used.tokens);
    if (q.remaining.tokens != null) h['x-gw-quota-tokens-remaining'] = String(q.remaining.tokens);
    if (q.remaining.requests != null) h['x-gw-quota-requests-remaining'] = String(q.remaining.requests);
    if (q.remaining.credits != null) h['x-gw-quota-credits-remaining'] = String(q.remaining.credits);
  }
  h['x-gw-client'] = c.id;
  return h;
};

async function handleProxy(req, res, url) {
  const cfg = ctx.cfg;
  const base = cfg.proxy.basePath.replace(/\/$/, '');
  const bodyStart = Date.now();
  const startTs = new Date().toISOString();
  const rid = reqId();

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,x-api-key,x-gw-key',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  // 1. 鉴权
  const authResult = authenticate(req, ctx.byHash);
  if (!authResult.ok) {
    const code = authResult.reason === 'missing_key' ? 401 : authResult.reason === 'disabled' ? 403 : 401;
    return sendApiError(res, code, `鉴权失败: ${authResult.reason}`, 'authentication_error');
  }
  const client = authResult.client;

  // 2. 读请求体
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, cfg.server.maxBodyBytes);
  } catch (e) {
    if (e.code === 'body_too_large') {
      return sendApiError(res, 413, '请求体超过大小限制', 'payload_too_large');
    }
    return sendApiError(res, 400, `读取请求体失败: ${e.message}`, 'bad_request');
  }

  let parsed = null;
  try {
    if (bodyBuf.length) parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    return sendApiError(res, 400, '请求体不是合法 JSON', 'invalid_json');
  }
  const model = typeof parsed?.model === 'string' ? parsed.model : null;

  // 3. 模型白名单
  if (model && !modelAllowed(client, model)) {
    return sendApiError(res, 403, `模型 ${model} 不在该 key 的允许范围内`, 'model_not_allowed');
  }

  // 4. 路由
  let routed;
  try {
    routed = routeProvider(model, cfg);
  } catch (e) {
    return sendApiError(res, 502, e.message, 'no_provider');
  }

  // 5. 配额预检
  const promptText = parsed ? JSON.stringify(parsed.messages ?? parsed.input ?? parsed.prompt ?? '') : '';
  const estTokens = estimateTokens(promptText, cfg.proxy.estimateCharsPerToken);
  const quota = checkQuota(client, store, estTokens);
  if (!quota.ok) {
    record({ status: 429, tokensIn: 0, tokensOut: 0, tokens: 0, cost: 0, err: quota.reason });
    return sendApiError(
      res,
      429,
      `额度已用尽（${quota.reason}）。周期=${quota.period} 已用=${quota.used.tokens} tokens / 上限=${quota.limits.tokens ?? '不限'}`,
      'insufficient_quota',
      { 'retry-after': '60', ...extraHeadersFor(quota, client) },
    );
  }

  // 6. 限流
  const gate = limiter.acquire(client.id, client.limits ?? {}, estTokens);
  if (!gate.ok) {
    record({ status: 429, tokensIn: 0, tokensOut: 0, tokens: 0, cost: 0, err: gate.reason });
    return sendApiError(res, 429, `触发限流: ${gate.reason}`, 'rate_limit_exceeded', {
      ...(gate.retryAfter ? { 'retry-after': String(gate.retryAfter) } : {}),
      ...gate.headers,
      ...extraHeadersFor(quota, client),
    });
  }

  // 7. 转发
  const suffix = (url.pathname.slice(base.length) || '/') + url.search;
  const ac = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort(new Error('client_closed'));
    }
  });

  let result;
  try {
    result = await forward({
      req,
      res,
      pathSuffix: suffix,
      bodyBuf,
      provider: routed.provider,
      providerName: routed.providerName,
      cfg,
      clientSignal: ac.signal,
      extraHeaders: extraHeadersFor(quota, client),
    });
  } catch (e) {
    record({ status: 502, tokensIn: 0, tokensOut: 0, tokens: 0, cost: 0, err: e.message });
    if (!res.headersSent) return sendApiError(res, 502, e.message, 'upstream_error');
    return res.end();
  } finally {
    limiter.release(client.id, client.limits ?? {}, estTokens, result?.usage?.total ?? null);
  }

  // 8. 计量（计价用客户端请求的模型名，上游可能把它改写为 auto/fast 之类）
  const price = resolvePrice(model ?? result.model ?? '', cfg.pricing);
  const cost = computeCost(result.usage, price);
  record({
    status: result.status,
    tokensIn: result.usage.in,
    tokensOut: result.usage.out,
    tokens: result.usage.total,
    cached: result.usage.cached ?? 0,
    credits: result.usage.credits ?? null,
    estimated: Boolean(result.usage.estimated),
    cost,
    model: model ?? result.model,
    rewrittenModel: result.model && result.model !== model ? result.model : undefined,
    provider: routed.providerName,
    stream: result.stream,
    ttfbMs: result.ttfbMs,
    err: result.status >= 400 ? 'upstream_status_' + result.status : undefined,
    clientGone,
  });

  function record(extra) {
    const e = {
      ts: startTs,
      reqId: rid,
      kind: 'request',
      clientId: client.id,
      clientName: client.name ?? client.id,
      path: url.pathname,
      method: req.method,
      clientIp: clientIp(req, cfg.server.trustProxy),
      ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
      periodKeys: allPeriodKeys(),
      latencyMs: Date.now() - bodyStart,
      ...extra,
    };
    store.record(e);
    logLine(e);
  }
}

/* ---------------- HTTP 服务 ---------------- */
const admin = createAdmin({
  getCtx: () => ctx,
  saveRuntime,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // 全局 CORS（本地工具链方便）
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', '*');

  if (url.pathname === '/health' || url.pathname === '/') {
    let bridgeHealth = null;
    if (bridge?.enabled) {
      bridge.refresh?.();
      bridgeHealth = bridge.info();
    }
    return sendJson(res, 200, {
      ok: true,
      service: 'local-llm-gateway',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      clients: ctx.cfg.clients.length,
      providers: Object.keys(ctx.cfg.providers),
      basePath: ctx.cfg.proxy.basePath,
      bridge: bridgeHealth,
    });
  }

  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    return Promise.resolve(
      admin.handle(req, res, url, { sendJson, readJson, readBody })
    ).catch((e) => {
      console.error('[admin]', e);
      if (!res.headersSent) sendApiError(res, 500, e.message, 'admin_internal_error');
      else res.end();
    });
  }

  const base = ctx.cfg.proxy.basePath.replace(/\/$/, '');
  if (url.pathname === base || url.pathname.startsWith(base + '/')) {
    return handleProxy(req, res, url).catch((e) => {
      console.error('[proxy]', e);
      if (!res.headersSent) sendApiError(res, 500, e.message, 'gateway_internal_error');
      else res.end();
    });
  }

  sendApiError(res, 404, `未知路径 ${url.pathname}，代理前缀为 ${base}`, 'not_found');
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const { host, port } = ctx.cfg.server;
let bridge = null;
server.listen(port, host, () => {
  console.log(`
┌──────────────────────────────────────────────┐
│  本地模型中转网关已启动                       │
└──────────────────────────────────────────────┘
  监听      http://${host}:${port}
  代理前缀  ${ctx.cfg.proxy.basePath}   例: POST ${ctx.cfg.proxy.basePath}/chat/completions
  管理接口  /admin/*（Bearer adminToken）
  上游      ${Object.entries(ctx.cfg.providers).map(([k, v]) => `${k}→${v.baseUrl}`).join('  ') || '未配置'}
  调用方    ${ctx.cfg.clients.map((c) => `${c.id}(${c.type})`).join('  ')}
  数据目录  ${dataDir}
`);

  // 桥接子进程：不阻塞监听，后台拉起
  bridge = createBridgeSupervisor({ cfg: ctx.cfg, root: ROOT });
  if (bridge.enabled) {
    bridge.start().catch((e) => console.warn(`[bridge] 启动异常: ${e.message}`));
  }
});

/* ---------------- 优雅退出 ---------------- */
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[gw] 收到 ${sig}，正在落盘并退出…`);
  try {
    bridge?.stop();
  } catch {
    /* ignore */
  }
  server.close(() => {
    store.flush();
    process.exit(0);
  });
  setTimeout(() => {
    store.flush();
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
