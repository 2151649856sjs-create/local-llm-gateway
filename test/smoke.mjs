/**
 * 端到端冒烟测试：起 mock 上游 + 网关，验证鉴权/计量/配额/限流/路由/日志
 * node test/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GW = 'http://127.0.0.1:8788';
const DATA = path.join(ROOT, 'data-test');
const ADMIN = 'test-admin-token-123';

let pass = 0;
let fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    results.push(`  ✔ ${name}`);
  } else {
    fail++;
    results.push(`  ✘ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function waitPort(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} 启动超时: ${url}`);
}

async function waitDown(url, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${label} 未停止: ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(key, opts = {}) {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? 'mock-1',
      messages: [{ role: 'user', content: opts.content ?? '你好，帮我写一段测试文本' }],
      stream: Boolean(opts.stream),
    }),
  });
  if (opts.stream && r.ok) {
    const text = await r.text();
    return { status: r.status, text, headers: r.headers };
  }
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, json, headers: r.headers };
}

async function admin(pathname, init = {}) {
  const r = await fetch(`${GW}/admin${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// 清理上次数据
fs.rmSync(DATA, { recursive: true, force: true });

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-upstream.mjs'), '9999'], { stdio: 'ignore' });
const gw = spawn(
  process.execPath,
  [path.join(ROOT, 'src', 'server.mjs'), '--config', path.join(__dirname, 'config.test.json'), '--data', DATA],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let gwErr = '';
gw.stderr.on('data', (d) => (gwErr += d.toString()));

const cleanup = () => {
  mock.kill();
  gw.kill();
};
process.on('exit', cleanup);

try {
  await waitPort('http://127.0.0.1:9999/ping', 'mock 上游');
  await waitPort(`${GW}/health`, '网关');

  // 1. 健康检查
  const health = await (await fetch(`${GW}/health`)).json();
  ok('健康检查返回 ok', health.ok === true, JSON.stringify(health));

  // 2. 鉴权
  const noKey = await fetch(`${GW}/v1/chat/completions`, { method: 'POST', body: '{}' });
  ok('无 key 返回 401', noKey.status === 401);
  const badKey = await chat('sk-not-exist');
  ok('错误 key 返回 401', badKey.status === 401, String(badKey.status));

  // 3. 正常转发（非流式）
  const r1 = await chat('sk-test-normal');
  ok('正常请求 200', r1.status === 200, String(r1.status));
  ok('上游响应体透传', r1.json?.choices?.[0]?.message?.content === '这是模拟回复');
  ok('响应带上游 provider 头', r1.headers.get('x-gw-provider') === 'mock');
  ok('响应带配额头', r1.headers.get('x-gw-quota-tokens-remaining') !== null);

  // 4. 用量记账
  const u1 = await admin('/usage?client=t-normal');
  ok('非流式请求计入 token', u1.json?.usage?.tokens > 0, JSON.stringify(u1.json?.usage));
  ok('请求数 +1', u1.json?.usage?.requests === 1, String(u1.json?.usage?.requests));
  ok('计算了成本', u1.json?.usage?.cost > 0, String(u1.json?.usage?.cost));
  ok('按模型分组', Boolean(u1.json?.usage?.byModel?.['mock-1']));

  // 5. 流式转发 + usage 解析
  const r2 = await chat('sk-test-normal', { stream: true });
  ok('流式请求 200', r2.status === 200);
  ok('流式返回多条 SSE', (r2.text.match(/data:/g) ?? []).length >= 3, String((r2.text.match(/data:/g) ?? []).length));
  ok('流式含 [DONE]', r2.text.includes('[DONE]'));
  const u2 = await admin('/usage?client=t-normal');
  ok('流式 usage 已解析（>1 次请求的 token）', u2.json?.usage?.tokens > u1.json?.usage?.tokens, `${u1.json?.usage?.tokens} → ${u2.json?.usage?.tokens}`);
  ok('流式请求也计了请求数', u2.json?.usage?.requests === 2, String(u2.json?.usage?.requests));

  // 6. 配额耗尽
  let quotaHit = null;
  for (let i = 0; i < 12; i++) {
    const r = await chat('sk-test-quota');
    if (r.status === 429) {
      quotaHit = r.json;
      break;
    }
  }
  ok('额度耗尽后返回 429', quotaHit !== null, '连续请求未触发配额');
  ok('429 错误码为 insufficient_quota', quotaHit?.error?.type === 'insufficient_quota', JSON.stringify(quotaHit?.error));

  // 7. 限流（rpm=2）
  const rr = [];
  for (let i = 0; i < 3; i++) rr.push(await chat('sk-test-rpm'));
  ok('rpm 超限返回 429', rr[2].status === 429, rr.map((x) => x.status).join(','));
  ok('限流错误类型正确', rr[2].json?.error?.type === 'rate_limit_exceeded', JSON.stringify(rr[2].json?.error));

  // 8. 模型白名单
  const denied = await chat('sk-test-model', { model: 'mock-1' });
  ok('模型不在白名单 → 403', denied.status === 403, String(denied.status));
  const allowed = await chat('sk-test-model', { model: 'mock-allowed' });
  ok('白名单内模型放行', allowed.status === 200, String(allowed.status));

  // 9. 管理接口：创建 client 并立即使用
  const created = await admin('/clients', {
    method: 'POST',
    body: JSON.stringify({
      id: 't-created',
      name: '运行时创建',
      type: 'agent',
      quota: { period: 'daily', tokens: 1000 },
      limits: { rpm: 10 },
      models: { allow: ['*'] },
    }),
  });
  ok('创建 client 返回 201', created.status === 201, String(created.status));
  ok('创建时返回明文 key', typeof created.json?.key === 'string' && created.json.key.startsWith('sk-gw-'));
  const useNew = await chat(created.json.key);
  ok('新 key 可立即使用', useNew.status === 200, String(useNew.status));

  // 10. 重复 id 冲突
  const dup = await admin('/clients', { method: 'POST', body: JSON.stringify({ id: 't-created' }) });
  ok('重复 id 返回 409', dup.status === 409, String(dup.status));

  // 11. PATCH 停用后拒绝
  await admin('/clients/t-created', { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  const disabled = await chat(created.json.key);
  ok('停用后该 key 返回 403', disabled.status === 403, String(disabled.status));

  // 12. 台账
  const ledger = await admin('/ledger?limit=5');
  ok('台账有记录', Array.isArray(ledger.json?.rows) && ledger.json.rows.length > 0);
  const last = ledger.json?.rows?.at(-1);
  ok('台账字段完整', Boolean(last?.ts && last?.clientId && last?.status && last?.tokens !== undefined && last?.latencyMs !== undefined), JSON.stringify(last));

  // 13. 上游错误透传
  const badPath = await fetch(`${GW}/v1/chat/../fail`, {
    headers: { authorization: 'Bearer sk-test-normal' },
  });
  ok('未知上游路径有响应（不崩）', badPath.status >= 400, String(badPath.status));

  // 14. admin 鉴权
  const noAdmin = await fetch(`${GW}/admin/clients`);
  ok('admin 无 token 返回 401', noAdmin.status === 401);

  // 15. 重启后用量仍在
  const uBefore = await admin('/usage?client=t-normal');
  await sleep(1800); // 等台账/快照刷盘
  gw.kill('SIGTERM');
  await waitDown(`${GW}/health`, '网关');
  const gw2 = spawn(
    process.execPath,
    [path.join(ROOT, 'src', 'server.mjs'), '--config', path.join(__dirname, 'config.test.json'), '--data', DATA],
    { stdio: 'ignore' },
  );
  await waitPort(`${GW}/health`, '网关（重启）');
  const u3 = await admin('/usage?client=t-normal');
  ok(
    '重启后用量从台账恢复',
    u3.json?.usage?.tokens === uBefore.json?.usage?.tokens && u3.json?.usage?.requests === uBefore.json?.usage?.requests,
    `${uBefore.json?.usage?.tokens}/${uBefore.json?.usage?.requests} → ${u3.json?.usage?.tokens}/${u3.json?.usage?.requests}`,
  );
  const snapExists = fs.existsSync(path.join(DATA, 'snapshot.json'));
  ok('快照文件已生成', snapExists);
  const ledgerExists = fs.existsSync(path.join(DATA, 'ledger.jsonl'));
  ok('台账文件已生成', ledgerExists);
  gw2.kill();
} catch (e) {
  fail++;
  results.push(`  ✘ 测试异常: ${e.message}\n${gwErr}`);
} finally {
  cleanup();
  console.log('\n测试结果');
  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
}
