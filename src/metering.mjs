/**
 * 计量：用量提取、token 估算、计价
 */
import { matchGlob } from './config.mjs';

/** 把不同厂商的 usage 结构归一化 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const inTok =
    num(u.prompt_tokens) ?? num(u.input_tokens) ?? num(u.promptTokens) ?? num(u.inputTokens);
  const outTok =
    num(u.completion_tokens) ?? num(u.output_tokens) ?? num(u.completionTokens) ?? num(u.outputTokens);
  if (inTok == null && outTok == null) return null;
  const cached = num(u.prompt_cache_hit_tokens) ?? num(u.cache_read_input_tokens) ?? num(u.prompt_tokens_details?.cached_tokens) ?? 0;
  return {
    in: inTok ?? 0,
    out: outTok ?? 0,
    total: num(u.total_tokens) ?? (inTok ?? 0) + (outTok ?? 0),
    cached,
    // 按 credits 计费的上游（Qoder 等）直接给额度消耗
    credits: num(u.credits) ?? num(u.credit) ?? null,
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 按 model 名从 pricing 表取价：精确匹配优先，其次 glob，最后 '*' */
export function resolvePrice(model, pricing) {
  if (!pricing) return { in: 0, out: 0 };
  if (pricing[model]) return norm(pricing[model]);
  for (const key of Object.keys(pricing)) {
    if (key === '*') continue;
    if (matchGlob(key, model)) return norm(pricing[key]);
  }
  return norm(pricing['*'] ?? { in: 0, out: 0 });
}

function norm(p) {
  return { in: Number(p.in ?? 0), out: Number(p.out ?? 0) };
}

/** 价格单位：每 100 万 token。cached 命中的输入按 0.2 折（可被 price.cachedIn 覆盖） */
export function computeCost(usage, price) {
  if (!usage) return 0;
  const cachedRate = price.cachedIn ?? 0.2;
  const billableIn = Math.max(0, usage.in - usage.cached) + usage.cached * cachedRate;
  return (billableIn * price.in + usage.out * price.out) / 1_000_000;
}

/** 无 usage 时的兜底估算（按字符数） */
export function estimateTokens(text, charsPerToken = 3.5) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / charsPerToken));
}

/**
 * 从流式 SSE 文本里提取 usage。
 * 累加 chunk，按事件切分，找含 usage 的 data 行。
 */
export function createSSEUsageScanner() {
  let buf = '';
  let usage = null;
  let model = null;
  let sawDone = false;

  return {
    push(text) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }
        try {
          const obj = JSON.parse(payload);
          if (obj?.model) model = obj.model;
          const u = normalizeUsage(obj?.usage);
          if (u) usage = u;
          // Anthropic 风格：message_delta 里带 usage
          if (obj?.type === 'message_delta' && obj.usage) {
            const u2 = normalizeUsage(obj.usage);
            if (u2) usage = u2;
          }
          if (obj?.type === 'message_start' && obj.message?.usage) {
            const u3 = normalizeUsage(obj.message.usage);
            if (u3) usage = u3;
          }
        } catch {
          /* 非 JSON 数据行忽略 */
        }
      }
    },
    get usage() {
      return usage;
    },
    get model() {
      return model;
    },
    get sawDone() {
      return sawDone;
    },
  };
}

/** 周期标识：总/日/月 */
export function periodKey(period) {
  const d = new Date();
  if (period === 'daily') {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  if (period === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return 'all';
}
