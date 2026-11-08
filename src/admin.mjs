/**
 * 管理接口：/admin/*
 * 全部需要 adminToken 鉴权。
 */
import crypto from 'node:crypto';
import { hashKey, normalizeKey } from './config.mjs';
import { quotaPeriodKeys, allPeriodKeys } from './auth.mjs';

export function createAdmin({ getCtx, saveRuntime }) {
  /** getCtx() -> {cfg, byHash, store, limiter, startedAt, reload} */

  function auth(req, ctx) {
    const h = req.headers['authorization'] || req.headers['x-admin-token'] || '';
    const tok = /^Bearer\s+(.+)$/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : h.trim();
    return tok && tok === ctx.cfg.server.adminToken;
  }

  function publicClient(c, ctx) {
    const keys = quotaPeriodKeys(c);
    const snap = ctx.store.summary(c.id, keys);
    const totals = snap.total;
    const periodBucket = keys[0];
    const used = snap.periods[periodBucket] ?? { tokens: 0, requests: 0, cost: 0, credits: 0 };
    return {
      id: c.id,
      name: c.name ?? c.id,
      type: c.type,
      enabled: c.enabled,
      quota: c.quota ?? {},
      limits: c.limits ?? {},
      models: c.models ?? { allow: ['*'] },
      keyPreview: c.key ? `${c.key.slice(0, 8)}…${c.key.slice(-4)}` : 'sha256(隐藏)',
      usage: {
        period: c.quota?.period ?? 'total',
        periodBucket,
        tokens: used.tokens,
        tokensIn: used.tokensIn,
        tokensOut: used.tokensOut,
        cost: round(used.cost),
        credits: round(used.credits ?? 0),
        requests: used.requests,
        errors: used.errors,
        lifetime: {
          tokens: totals.tokens,
          cost: round(totals.cost),
          credits: round(totals.credits ?? 0),
          requests: totals.requests,
          errors: totals.errors,
        },
        remaining: {
          tokens: c.quota?.tokens != null ? Math.max(0, c.quota.tokens - used.tokens) : null,
          requests: c.quota?.requests != null ? Math.max(0, c.quota.requests - used.requests) : null,
          cost: c.quota?.cost != null ? round(Math.max(0, c.quota.cost - used.cost)) : null,
          credits: c.quota?.credits != null ? round(Math.max(0, c.quota.credits - (used.credits ?? 0))) : null,
        },
        byModel: Object.fromEntries(
          Object.entries(snap.byModel).map(([m, v]) => [
            m,
            { tokens: v.tokens, cost: round(v.cost), credits: round(v.credits ?? 0), requests: v.requests },
          ]),
        ),
      },
      runtime: ctx.limiter.stats(c.id),
    };
  }

  function round(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  async function handle(req, res, url, helpers) {
    const ctx = getCtx();
    if (!auth(req, ctx)) return helpers.sendJson(res, 401, { error: 'admin_token_invalid' });

    const p = url.pathname.replace(/^\/admin/, '') || '/';
    const m = req.method;

    // 列表
    if (p === '/' || p === '/status') {
      return helpers.sendJson(res, 200, {
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        pid: process.pid,
        configPath: ctx.configPath,
        providers: Object.keys(ctx.cfg.providers),
        clients: ctx.cfg.clients.length,
        totals: globalTotals(ctx),
      });
    }

    if (p === '/config') {
      const safe = JSON.parse(JSON.stringify({ ...ctx.cfg, clients: [] }));
      safe.server.adminToken = '***';
      for (const prov of Object.values(safe.providers)) prov.apiKey = '***';
      return helpers.sendJson(res, 200, safe);
    }

    if (p === '/clients' && m === 'GET') {
      return helpers.sendJson(res, 200, { clients: ctx.cfg.clients.map((c) => publicClient(c, ctx)) });
    }

    if (p === '/clients' && m === 'POST') {
      const body = await helpers.readJson(req);
      if (!body?.id) return helpers.sendJson(res, 400, { error: 'id_required' });
      return createClient(body, ctx, helpers, res);
    }

    const mId = /^\/clients\/([^/]+)(\/reset)?$/.exec(p);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      const client = ctx.cfg.clients.find((c) => c.id === id);
      if (!client) return helpers.sendJson(res, 404, { error: 'client_not_found', id });

      if (mId[2] && m === 'POST') {
        ctx.store.reset(id, 'admin');
        return helpers.sendJson(res, 200, { ok: true, reset: id });
      }
      if (m === 'GET') return helpers.sendJson(res, 200, publicClient(client, ctx));
      if (m === 'PATCH') {
        const body = await helpers.readJson(req);
        for (const k of ['name', 'enabled', 'quota', 'limits', 'models', 'type']) {
          if (body[k] !== undefined) client[k] = body[k];
        }
        if (body.key) {
          const nk = normalizeKey(body.key);
          ctx.byHash.delete(client._hash);
          client._hash = nk.hash;
          client.key = nk.raw;
          ctx.byHash.set(nk.hash, client);
        }
        saveRuntime(ctx);
        return helpers.sendJson(res, 200, publicClient(client, ctx));
      }
      if (m === 'DELETE') {
        ctx.byHash.delete(client._hash);
        ctx.cfg.clients = ctx.cfg.clients.filter((c) => c.id !== id);
        saveRuntime(ctx);
        return helpers.sendJson(res, 200, { ok: true, deleted: id });
      }
    }

    if (p === '/usage' && m === 'GET') {
      const id = url.searchParams.get('client');
      if (id) {
        const c = ctx.cfg.clients.find((x) => x.id === id);
        if (!c) return helpers.sendJson(res, 404, { error: 'client_not_found' });
        return helpers.sendJson(res, 200, publicClient(c, ctx));
      }
      return helpers.sendJson(res, 200, { clients: ctx.cfg.clients.map((c) => publicClient(c, ctx)) });
    }

    if (p === '/ledger' && m === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50));
      const id = url.searchParams.get('client');
      let rows = ctx.store.tail(200);
      if (id) rows = rows.filter((r) => r.clientId === id);
      return helpers.sendJson(res, 200, { rows: rows.slice(-limit) });
    }

    if (p === '/reload' && m === 'POST') {
      const r = ctx.reload();
      return helpers.sendJson(res, 200, { ok: true, ...r });
    }

    return helpers.sendJson(res, 404, { error: 'admin_route_not_found', path: p });
  }

  function globalTotals(ctx) {
    let tokens = 0;
    let cost = 0;
    let requests = 0;
    for (const c of ctx.cfg.clients) {
      const s = ctx.store.summary(c.id, allPeriodKeys());
      tokens += s.total.tokens;
      cost += s.total.cost;
      requests += s.total.requests;
    }
    return { tokens, cost: round(cost), requests };
  }

  function createClient(body, ctx, helpers, res) {
    if (ctx.cfg.clients.some((c) => c.id === body.id)) {
      return helpers.sendJson(res, 409, { error: 'client_exists', id: body.id });
    }
    const raw = body.key || `sk-gw-${crypto.randomBytes(18).toString('hex')}`;
    const nk = normalizeKey(raw);
    const client = {
      id: body.id,
      name: body.name ?? body.id,
      type: body.type ?? 'generic',
      key: nk.raw ?? raw,
      enabled: body.enabled ?? true,
      quota: body.quota ?? {},
      limits: body.limits ?? {},
      models: body.models ?? { allow: ['*'] },
      _hash: nk.hash,
      _runtime: true,
    };
    ctx.cfg.clients.push(client);
    ctx.byHash.set(nk.hash, client);
    saveRuntime(ctx);
    return helpers.sendJson(res, 201, {
      ...publicClient(client, ctx),
      key: raw, // 仅创建时返回一次明文
      notice: '请立刻保存该 key，明文不会再次返回',
    });
  }

  return { handle };
}
