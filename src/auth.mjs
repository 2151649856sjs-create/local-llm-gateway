/**
 * 鉴权与配额判定
 */
import { hashKey } from './config.mjs';
import { periodKey } from './metering.mjs';

/** 从请求头取 bearer key */
export function extractKey(req) {
  const h = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  if (h && !h.includes(' ')) return h.trim();
  const q = req.headers['x-gw-key'];
  if (typeof q === 'string' && q) return q.trim();
  return null;
}

export function authenticate(req, byHash) {
  const raw = extractKey(req);
  if (!raw) return { ok: false, reason: 'missing_key' };
  const c = byHash.get(hashKey(raw));
  if (!c) return { ok: false, reason: 'invalid_key' };
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return { ok: true, client: c };
}

/** 台账里统一记录三种周期，便于后续改周期不丢历史 */
export function allPeriodKeys() {
  return ['all', periodKey('daily'), periodKey('monthly')];
}

export function quotaPeriodKeys(client) {
  const p = client.quota?.period ?? 'total';
  return p === 'daily' || p === 'monthly' ? [periodKey(p)] : ['all'];
}

/**
 * 配额预检。返回剩余额度和是否放行。
 * 三个维度（tokens / requests / cost）任一超限即拒绝。
 */
export function checkQuota(client, store, estTokens) {
  const keys = quotaPeriodKeys(client);
  const usage = store.usageOf(client.id, keys);
  const p = client.quota?.period ?? 'total';
  const key = p === 'daily' || p === 'monthly' ? periodKey(p) : 'all';
  const bucket = usage.periods[key] ?? { tokens: 0, requests: 0, cost: 0, credits: 0 };
  const q = client.quota ?? {};
  const out = {
    period: p,
    bucket: key,
    used: { tokens: bucket.tokens, requests: bucket.requests, cost: bucket.cost, credits: bucket.credits ?? 0 },
    limits: { tokens: q.tokens ?? null, requests: q.requests ?? null, cost: q.cost ?? null, credits: q.credits ?? null },
    remaining: {
      tokens: q.tokens != null ? Math.max(0, q.tokens - bucket.tokens) : null,
      requests: q.requests != null ? Math.max(0, q.requests - bucket.requests) : null,
      cost: q.cost != null ? Math.max(0, q.cost - bucket.cost) : null,
      credits: q.credits != null ? Math.max(0, q.credits - (bucket.credits ?? 0)) : null,
    },
  };

  if (q.requests != null && bucket.requests >= q.requests) {
    return { ...out, ok: false, reason: 'quota_requests_exhausted' };
  }
  if (q.tokens != null && bucket.tokens >= q.tokens) {
    return { ...out, ok: false, reason: 'quota_tokens_exhausted' };
  }
  // 预估本次会超 → 提前拒绝（避免"最后一次请求"超额太多）
  if (q.tokens != null && bucket.tokens + estTokens > q.tokens) {
    return { ...out, ok: false, reason: 'quota_tokens_exceeded_by_request' };
  }
  if (q.cost != null && bucket.cost >= q.cost) {
    return { ...out, ok: false, reason: 'quota_cost_exhausted' };
  }
  if (q.credits != null && (bucket.credits ?? 0) >= q.credits) {
    return { ...out, ok: false, reason: 'quota_credits_exhausted' };
  }
  return { ...out, ok: true };
}

/** 模型白名单 */
export function modelAllowed(client, model) {
  const allow = client.models?.allow ?? ['*'];
  if (allow.includes('*')) {
    const deny = client.models?.deny ?? [];
    return !deny.some((d) => matchSimple(d, model));
  }
  return allow.some((a) => matchSimple(a, model));
}

function matchSimple(glob, value) {
  if (glob === value) return true;
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i').test(value);
}
