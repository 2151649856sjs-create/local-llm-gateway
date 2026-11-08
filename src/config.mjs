/**
 * 配置加载与校验
 * 环境变量覆盖：GW_CONFIG / GW_HOST / GW_PORT / GW_ADMIN_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    adminToken: '',
    maxBodyBytes: 10 * 1024 * 1024,
    requestTimeoutMs: 180_000,
    trustProxy: false,
  },
  proxy: {
    basePath: '/v1',
    currency: 'CNY',
    injectStreamUsage: true,
    estimateCharsPerToken: 3.5,
    unknownModelPolicy: 'fallback', // fallback | reject
    defaultProvider: null, // 无 model 字段的请求（/models 等）走这里
  },
  providers: {},
  routes: [{ match: '*', provider: 'default' }],
  pricing: { '*': { in: 0, out: 0 } },
  clients: [],
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  if (typeof extra !== 'object' || extra === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
  return out;
}

export function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** key 可为明文，也可写成 "sha256:<hex>" 只存哈希 */
export function normalizeKey(key) {
  if (typeof key !== 'string' || !key) return null;
  if (key.startsWith('sha256:')) {
    return { hash: key.slice(7).toLowerCase(), raw: null };
  }
  return { hash: hashKey(key), raw: key };
}

export function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`配置文件不存在: ${abs}`);
  let user;
  try {
    user = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`配置文件 JSON 解析失败: ${e.message}`);
  }
  const cfg = deepMerge(DEFAULTS, user);

  if (process.env.GW_HOST) cfg.server.host = process.env.GW_HOST;
  if (process.env.GW_PORT) cfg.server.port = Number(process.env.GW_PORT);
  if (process.env.GW_ADMIN_TOKEN) cfg.server.adminToken = process.env.GW_ADMIN_TOKEN;

  if (!Array.isArray(cfg.clients) || cfg.clients.length === 0) {
    throw new Error('clients 至少需要配置一个（可用 tools 里的生成命令创建）');
  }
  if (!cfg.server.adminToken || cfg.server.adminToken.length < 8) {
    throw new Error('server.adminToken 必须设置且长度 ≥ 8');
  }

  // provider 校验
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p.baseUrl) throw new Error(`providers.${name}.baseUrl 缺失`);
    if (!p.apiKey) throw new Error(`providers.${name}.apiKey 缺失`);
    p.baseUrl = p.baseUrl.replace(/\/+$/, '');
    p.timeoutMs ??= cfg.server.requestTimeoutMs;
    p.headers ??= {};
  }

  // client 校验 + 建索引
  const byHash = buildIndex(cfg);

  return { cfg, byHash, configPath: abs };
}

export function buildIndex(cfg) {
  const byHash = new Map();
  for (const c of cfg.clients) {
    if (!c.id) throw new Error('client 缺少 id');
    if (!c.key && !c.keyHash) throw new Error(`client ${c.id} 缺少 key 或 keyHash`);
    const nk = c.keyHash ? { hash: c.keyHash.toLowerCase(), raw: null } : normalizeKey(c.key);
    if (byHash.has(nk.hash)) throw new Error(`client key 重复: ${c.id}`);
    c.enabled ??= true;
    c.type ??= 'generic';
    c.quota ??= {};
    c.limits ??= {};
    c.models ??= { allow: ['*'] };
    c.models.allow ??= ['*'];
    c._hash = nk.hash;
    byHash.set(nk.hash, c);
  }
  return byHash;
}

/** 简易 glob → RegExp，只支持 * 和 ? */
export function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

const matchers = new Map();
export function matchGlob(glob, value) {
  let re = matchers.get(glob);
  if (!re) {
    re = globToRe(glob);
    matchers.set(glob, re);
  }
  return re.test(value);
}
