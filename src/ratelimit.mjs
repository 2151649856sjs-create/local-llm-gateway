/**
 * 限流：令牌桶（RPM）+ 60s 滑动窗口（TPM）+ 并发闸门
 * 全部内存态，进程重启归零——本地网关可接受。
 */

export function createLimiter() {
  const buckets = new Map(); // clientId -> {rpmTokens, lastRefill, tpmWindow: [{ts,tok}], inflight}

  function slot(id) {
    let s = buckets.get(id);
    if (!s) {
      s = { rpmTokens: null, lastRefill: Date.now(), tpmWindow: [], inflight: 0, tpm: null };
      buckets.set(id, s);
    }
    return s;
  }

  /**
   * @param {string} id
   * @param {{rpm?:number,tpm?:number,maxConcurrent?:number}} limits
   * @param {number} estTokens 本次请求预估 token（用于 TPM 预检）
   * @returns {{ok:boolean, reason?:string, retryAfter?:number, headers:Object}}
   */
  function acquire(id, limits, estTokens = 0) {
    const s = slot(id);
    const now = Date.now();
    const headers = {};

    // 并发
    if (limits.maxConcurrent > 0 && s.inflight >= limits.maxConcurrent) {
      return { ok: false, reason: 'concurrency_exceeded', retryAfter: 1, headers };
    }

    // RPM 令牌桶
    if (limits.rpm > 0) {
      if (s.rpmTokens === null) s.rpmTokens = limits.rpm;
      const ratePerMs = limits.rpm / 60000;
      s.rpmTokens = Math.min(limits.rpm, s.rpmTokens + (now - s.lastRefill) * ratePerMs);
      s.lastRefill = now;
      if (s.rpmTokens < 1) {
        const need = (1 - s.rpmTokens) / ratePerMs;
        return { ok: false, reason: 'rpm_exceeded', retryAfter: Math.ceil(need / 1000), headers };
      }
    }

    // TPM 滑动窗口
    if (limits.tpm > 0) {
      s.tpmWindow = s.tpmWindow.filter((x) => now - x.ts < 60_000);
      const used = s.tpmWindow.reduce((a, x) => a + x.tok, 0);
      if (used + estTokens > limits.tpm) {
        const oldest = s.tpmWindow[0];
        const retry = oldest ? Math.ceil((60_000 - (now - oldest.ts)) / 1000) : 1;
        headers['retry-after'] = String(retry);
        return { ok: false, reason: 'tpm_exceeded', retryAfter: retry, headers };
      }
      s.tpmWindow.push({ ts: now, tok: estTokens });
      s.tpm = { used: used + estTokens, limit: limits.tpm };
    }

    if (limits.maxConcurrent > 0) s.inflight += 1;

    if (limits.rpm > 0) {
      s.rpmTokens -= 1;
      headers['x-ratelimit-limit-requests'] = String(limits.rpm);
      headers['x-ratelimit-remaining-requests'] = String(Math.floor(s.rpmTokens));
    }
    if (limits.tpm > 0 && s.tpm) {
      headers['x-ratelimit-limit-tokens'] = String(s.tpm.limit);
      headers['x-ratelimit-remaining-tokens'] = String(Math.max(0, s.tpm.limit - s.tpm.used));
    }
    return { ok: true, headers };
  }

  /** 请求结束后：归还并发，按实际 token 校正 TPM 窗口 */
  function release(id, limits, estTokens = 0, actualTokens = null) {
    const s = buckets.get(id);
    if (!s) return;
    if (limits.maxConcurrent > 0) s.inflight = Math.max(0, s.inflight - 1);
    if (limits.tpm > 0 && actualTokens != null && s.tpmWindow.length) {
      const delta = actualTokens - estTokens;
      if (delta !== 0) {
        // 把差额记到当前时间点
        s.tpmWindow.push({ ts: Date.now(), tok: delta });
      }
    }
  }

  function stats(id) {
    const s = buckets.get(id);
    if (!s) return { inflight: 0 };
    return { inflight: s.inflight, rpmTokens: s.rpmTokens };
  }

  return { acquire, release, stats };
}
