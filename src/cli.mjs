#!/usr/bin/env node
/**
 * 网关命令行：查额度、加 agent、看台账
 * node src/cli.mjs <命令> [参数]
 *
 * 命令：
 *   status                  服务与总量概览
 *   clients                 列出所有调用方及用量
 *   usage [clientId]        用量明细（省略 id 则列全部）
 *   log [-n 20] [clientId]  最近请求台账
 *   add <id> [选项]          新增调用方
 *        --name <名字> --type agent|generic
 *        --tokens <n> --requests <n> --cost <n> --period total|daily|monthly
 *        --rpm <n> --tpm <n> --concurrency <n> --allow <m1,m2>
 *   patch <id> --enable|--disable|--tokens <n> --rpm <n>
 *   reset <id>              清零用量
 *   rm <id>                 删除调用方
 *   reload                  重载配置文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.resolve(process.env.GW_CONFIG ?? path.join(ROOT, 'config.json'));

if (!fs.existsSync(cfgPath)) {
  console.error(`找不到配置: ${cfgPath}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const BASE = `http://${cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host}:${cfg.server.port}`;
const TOKEN = process.env.GW_ADMIN_TOKEN ?? cfg.server.adminToken;

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
}
function has(name) {
  return argv.includes(`--${name}`);
}

async function api(p, init = {}) {
  const r = await fetch(BASE + '/admin' + p, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) {
    console.error(`请求失败 ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    process.exit(1);
  }
  return body;
}

function fmtLocal(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtTokens(n) {  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function bar(used, limit, width = 16) {
  if (limit == null) return '不限';
  const ratio = limit ? Math.min(1, used / limit) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled) + ` ${(ratio * 100).toFixed(0)}%`;
}

function printClients(list) {
  for (const c of list) {
    const u = c.usage;
    const cur = c.currency ?? '';
    console.log(`\n● ${c.id}  (${c.name}${c.type === 'agent' ? ' / agent' : ' / 通用key'})${c.enabled ? '' : '  [已停用]'}`);
    console.log(`  key        ${c.keyPreview}`);
    console.log(`  周期       ${u.period} → ${u.periodBucket}`);
    if (c.quota.tokens != null) {
      console.log(`  token      ${fmtTokens(u.tokens)} / ${fmtTokens(c.quota.tokens)}  ${bar(u.tokens, c.quota.tokens)}`);
    } else {
      console.log(`  token      ${fmtTokens(u.tokens)}（未设上限）`);
    }
    if (c.quota.requests != null) console.log(`  请求数     ${u.requests} / ${c.quota.requests}  ${bar(u.requests, c.quota.requests)}`);
    if (c.quota.cost != null) console.log(`  花费       ${u.cost} / ${c.quota.cost}`);
    if (c.quota.credits != null) {
      console.log(`  额度credits ${u.credits} / ${c.quota.credits}  ${bar(u.credits, c.quota.credits)}`);
    } else if (u.credits > 0) {
      console.log(`  额度credits ${u.credits}（未设上限）`);
    }
    const lim = [];
    if (c.limits.rpm) lim.push(`rpm=${c.limits.rpm}`);
    if (c.limits.tpm) lim.push(`tpm=${c.limits.tpm}`);
    if (c.limits.maxConcurrent) lim.push(`并发=${c.limits.maxConcurrent}`);
    console.log(`  限流       ${lim.join(' ') || '无'}`);
    console.log(`  模型       ${(c.models.allow ?? []).join(',')}${c.models.deny ? '  拒绝:' + c.models.deny.join(',') : ''}`);
    console.log(`  累计       ${fmtTokens(u.lifetime.tokens)} tokens / ${u.lifetime.requests} 次 / 花费 ${u.lifetime.cost}`);
    if (Object.keys(u.byModel).length) {
      const rows = Object.entries(u.byModel).map(
        ([m, v]) => `    ${m}: ${fmtTokens(v.tokens)} tokens, ${v.requests} 次, ${v.credits ?? 0} credits, 花费 ${v.cost}`,
      );
      console.log('  按模型\n' + rows.join('\n'));
    }
  }
}

const quotaFromFlags = () => {
  const q = {};
  if (flag('tokens')) q.tokens = Number(flag('tokens'));
  if (flag('requests')) q.requests = Number(flag('requests'));
  if (flag('cost')) q.cost = Number(flag('cost'));
  if (flag('credits')) q.credits = Number(flag('credits'));
  if (flag('period')) q.period = flag('period');
  return q;
};
const limitsFromFlags = () => {
  const l = {};
  if (flag('rpm')) l.rpm = Number(flag('rpm'));
  if (flag('tpm')) l.tpm = Number(flag('tpm'));
  if (flag('concurrency')) l.maxConcurrent = Number(flag('concurrency'));
  return l;
};

switch (cmd) {
  case 'status': {
    const s = await api('/status');
    console.log(`服务      ${BASE}  运行 ${s.uptimeSec}s  pid=${s.pid}`);
    console.log(`上游      ${s.providers.join(', ')}`);
    console.log(`调用方    ${s.clients} 个`);
    console.log(`累计用量  ${fmtTokens(s.totals.tokens)} tokens / ${s.totals.requests} 次 / ${s.totals.cost}`);
    break;
  }
  case 'clients':
  case 'usage': {
    const one = argv[1] && !argv[1].startsWith('--') ? await api(`/usage?client=${encodeURIComponent(argv[1])}`) : null;
    if (one) printClients([one]);
    else printClients((await api('/clients')).clients);
    break;
  }
  case 'log': {
    const n = Number(flag('n', 20));
    const id = argv[1] && !argv[1].startsWith('-') && argv[1] !== '-n' ? argv[1] : flag('client');
    const q = `/ledger?limit=${n}${id ? `&client=${encodeURIComponent(id)}` : ''}`;
    const { rows } = await api(q);
    if (!rows.length) {
      console.log('（暂无记录）');
      break;
    }
    console.log('时间                调用方            模型                 状态  in/out      耗时    ');
    console.log('─'.repeat(100));
    for (const r of rows) {
      console.log(
        `${fmtLocal(r.ts).padEnd(20)} ${String(r.clientId ?? '').padEnd(16)} ${String(r.model ?? '-').padEnd(20)} ${String(
          r.status ?? '',
        ).padEnd(4)} ${String((r.tokensIn ?? 0) + '/' + (r.tokensOut ?? 0)).padEnd(11)} ${String(r.latencyMs ?? '')}ms${
          r.err ? '  ' + r.err : ''
        }`,
      );
    }
    break;
  }
  case 'add': {
    const id = argv[1];
    if (!id) {
      console.error('用法: add <id> [--name 名字] [--tokens 200000] [--rpm 60] ...');
      process.exit(1);
    }
    const body = {
      id,
      name: flag('name', id),
      type: flag('type', 'agent'),
      quota: quotaFromFlags(),
      limits: limitsFromFlags(),
      models: { allow: flag('allow') ? flag('allow').split(',').map((s) => s.trim()) : ['*'] },
    };
    if (flag('deny')) body.models.deny = flag('deny').split(',').map((s) => s.trim());
    const r = await api('/clients', { method: 'POST', body: JSON.stringify(body) });
    console.log(`\n已创建 ${r.id}`);
    console.log(`key = ${r.key}\n`);
    console.log('（只显示这一次，请立刻保存）');
    break;
  }
  case 'patch': {
    const id = argv[1];
    const body = {};
    if (has('enable')) body.enabled = true;
    if (has('disable')) body.enabled = false;
    if (flag('name')) body.name = flag('name');
    if (flag('tokens') || flag('requests') || flag('cost') || flag('period')) body.quota = quotaFromFlags();
    if (flag('rpm') || flag('tpm') || flag('concurrency')) body.limits = limitsFromFlags();
    if (flag('allow')) body.models = { allow: flag('allow').split(',') };
    const r = await api(`/clients/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    console.log(`已更新 ${r.id}: enabled=${r.enabled} quota=${JSON.stringify(r.quota)} limits=${JSON.stringify(r.limits)}`);
    break;
  }
  case 'reset': {
    const r = await api(`/clients/${encodeURIComponent(argv[1])}/reset`, { method: 'POST' });
    console.log(`已清零 ${r.reset}`);
    break;
  }
  case 'rm': {
    const r = await api(`/clients/${encodeURIComponent(argv[1])}`, { method: 'DELETE' });
    console.log(`已删除 ${r.deleted}`);
    break;
  }
  case 'reload': {
    const r = await api('/reload', { method: 'POST' });
    console.log(JSON.stringify(r));
    break;
  }
  default:
    console.log(`用法: node src/cli.mjs <命令>
  status                  服务与总量概览
  clients                 列出所有调用方及用量
  usage [clientId]        用量明细
  log [-n 20] [clientId]  最近请求台账
  add <id> [--name --type --tokens --requests --cost --period --rpm --tpm --concurrency --allow --deny]
  patch <id> [--enable|--disable|--tokens --rpm ...]
  reset <id>              清零用量
  rm <id>                 删除调用方
  reload                  重载配置文件`);
}
