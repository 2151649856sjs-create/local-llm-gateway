/**
 * 转发核心：把请求改写到上游 provider，边转发边解析 usage
 */
import { matchGlob } from './config.mjs';
import { createSSEUsageScanner, estimateTokens, normalizeUsage } from './metering.mjs';

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'authorization',
  'x-api-key',
  'x-gw-key',
  'accept-encoding',
]);

/** 按 model 选 provider */
export function routeProvider(model, cfg) {
  const routes = cfg.routes ?? [];
  // 无 model 字段的请求（/models、/embeddings 等）走默认 provider
  if (!model && cfg.proxy?.defaultProvider) {
    const p = cfg.providers[cfg.proxy.defaultProvider];
    if (p) return { provider: p, providerName: cfg.proxy.defaultProvider, matched: 'default' };
  }
  if (model) {
    for (const r of routes) {
      if (r.match === '*' || matchGlob(r.match, model)) {
        const p = cfg.providers[r.provider];
        if (p) return { provider: p, providerName: r.provider, matched: r.match };
      }
    }
  }
  for (const r of routes) {
    if (r.match === '*') {
      const p = cfg.providers[r.provider];
      if (p) return { provider: p, providerName: r.provider, matched: '*' };
    }
  }
  const first = Object.keys(cfg.providers)[0];
  if (first) return { provider: cfg.providers[first], providerName: first, matched: 'default' };
  throw new Error('没有任何可用的 provider');
}

function buildUpstreamHeaders(req, provider) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out['authorization'] = `Bearer ${provider.apiKey}`;
  for (const [k, v] of Object.entries(provider.headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * @returns {Promise<{status:number, usage:object|null, model:string|null, ttfbMs:number, stream:boolean, bytes:number}>}
 */
export async function forward({ req, res, pathSuffix, bodyBuf, provider, providerName, cfg, clientSignal, extraHeaders = {} }) {
  const url = provider.baseUrl + pathSuffix;

  let parsed = null;
  if (bodyBuf.length) {
    try {
      parsed = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      /* 非 JSON 体，原样转发 */
    }
  }
  const isChat = /\/chat\/completions$/.test(pathSuffix);
  const wantStream = Boolean(parsed?.stream);
  const model = typeof parsed?.model === 'string' ? parsed.model : null;

  // 流式请求补齐 usage 统计开关（OpenAI 兼容上游）
  let outBody = bodyBuf;
  if (wantStream && isChat && cfg.proxy.injectStreamUsage && parsed && !parsed.stream_options) {
    parsed.stream_options = { include_usage: true };
    outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('upstream_timeout')), provider.timeoutMs);
  if (clientSignal) clientSignal.addEventListener('abort', () => controller.abort(new Error('client_aborted')), { once: true });

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: buildUpstreamHeaders(req, provider),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outBody,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`上游连接失败 (${providerName}): ${e.message}`);
  }

  const ttfbMs = Date.now() - started;

  // 回写响应头
  const hdrs = {};
  for (const [k, v] of upstream.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    hdrs[k] = v;
  }
  hdrs['x-gw-provider'] = providerName;
  res.writeHead(upstream.status, { ...hdrs, ...extraHeaders });

  let usage = null;
  let seenModel = model;
  let bytes = 0;
  let collected = 0;
  const chunks = [];
  const collectLimit = 2 * 1024 * 1024;

  if (upstream.body) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const scanner = wantStream && isChat ? createSSEUsageScanner() : null;
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      res.write(Buffer.from(chunk));
      if (collected < collectLimit) {
        const b = Buffer.from(chunk);
        chunks.push(b);
        collected += b.length;
      }
      if (scanner) scanner.push(decoder.decode(chunk, { stream: true }));
    }
    if (scanner) {
      scanner.push(decoder.decode());
      usage = scanner.usage;
      if (scanner.model) seenModel = scanner.model;
    }
  }
  res.end();
  clearTimeout(timeout);

  // 非流式：从完整 body 里取 usage
  if (!usage) {
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      const obj = JSON.parse(text);
      usage = normalizeUsage(obj?.usage);
      if (obj?.model) seenModel = obj.model;
      // 有些网关把 usage 藏在 choices 外层
      if (!usage && obj?.usage) usage = normalizeUsage(obj.usage);
    } catch {
      /* 忽略 */
    }
  }

  // 兜底估算
  if (!usage) {
    const promptText = parsed ? JSON.stringify(parsed.messages ?? parsed.input ?? parsed.prompt ?? '') : '';
    usage = {
      in: estimateTokens(promptText, cfg.proxy.estimateCharsPerToken),
      out: Math.ceil(bytes / (cfg.proxy.estimateCharsPerToken * 3)),
      total: 0,
      cached: 0,
      credits: null,
      estimated: true,
    };
    usage.total = usage.in + usage.out;
  }

  return { status: upstream.status, usage, model: seenModel, ttfbMs, stream: wantStream, bytes };
}
