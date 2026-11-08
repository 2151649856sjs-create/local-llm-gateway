/**
 * 检查 WorkBuddy 里 InternAI（书生）自定义模型是否还能用
 * 用法:
 *   node scripts/check-internai.mjs            # 只检查，不改配置
 *   node scripts/check-internai.mjs --prune    # 删掉已下线的条目（先备份）
 *   node scripts/check-internai.mjs --chat 3   # 抽 3 个模型发真实请求验证推理
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE ?? os.homedir();
const TARGET = path.join(HOME, '.workbuddy', 'models.json');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const PRUNE = argv.includes('--prune');
const CHAT_N = Number(arg('chat', 0));

const all = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
const mine = all.filter((m) => m.vendor === 'intern-ai');
if (!mine.length) {
  console.log('models.json 里没有 vendor=intern-ai 的条目，无需检查。');
  process.exit(0);
}

const baseUrl = mine[0].url.replace(/\/+$/, '');
const apiKey = mine[0].apiKey;
const keys = new Set(mine.map((m) => m.apiKey));
console.log(`配置文件 : ${TARGET}`);
console.log(`接口地址 : ${baseUrl}`);
console.log(`本地条目 : ${mine.length} 个（${keys.size} 个不同 key）\n`);

// 1) key 是否有效
let online = [];
try {
  const res = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  console.log(`GET /models → HTTP ${res.status}`);
  if (!res.ok) {
    const t = await res.text();
    console.log('  响应:', t.slice(0, 300));
    console.log('\n结论：key 或接口已不可用。');
    if (PRUNE) pruneAll('接口不可用');
    else console.log('加 --prune 可删除这些条目。');
    process.exit(0);
  }
  const j = await res.json();
  online = (j.data ?? []).map((m) => String(m.id));
  console.log(`  上游在线模型 ${online.length} 个\n`);
} catch (e) {
  console.log(`请求失败: ${e.message}`);
  console.log('\n结论：连不上，网络或接口已关停。');
  if (PRUNE) pruneAll('连不上');
  process.exit(0);
}

// 2) 逐条比对
const set = new Set(online.map((s) => s.toLowerCase()));
const alive = [];
const dead = [];
for (const m of mine) {
  (set.has(String(m.id).toLowerCase()) ? alive : dead).push(m);
}
console.log(`在线 ${alive.length} / 下线 ${dead.length}`);
for (const m of alive) console.log(`  ✔ ${m.id.padEnd(28)} ${m.name}`);
for (const m of dead) console.log(`  ✘ ${m.id.padEnd(28)} ${m.name}  （上游已无此模型）`);

// 3) 抽样验证推理
if (CHAT_N > 0 && alive.length) {
  const picks = alive.slice(0, CHAT_N);
  console.log('\n抽样对话验证:');
  for (const m of picks) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}` },
        body: JSON.stringify({
          model: m.id,
          messages: [{ role: 'user', content: '1+1等于几？只回答数字' }],
          max_tokens: 256, // 别设太小：思考模型光是 reasoning 就要一两百 token
          stream: false,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        console.log(`  ✘ ${m.id}: HTTP ${res.status} ${text.slice(0, 120)}`);
        continue;
      }
      const j = JSON.parse(text);
      const c = j.choices?.[0]?.message?.content ?? '';
      const r = j.choices?.[0]?.message?.reasoning_content ?? '';
      const out = String(c).trim();
      const tag = out ? '有正文' : r ? '仅思考' : '空响应';
      console.log(
        `  ✔ ${m.id}: [${tag}] "${out.slice(0, 30)}"${r && !out ? ' (reasoning ' + r.length + ' 字符)' : ''}  ${ms}ms`,
      );
    } catch (e) {
      console.log(`  ✘ ${m.id}: ${e.message}`);
    }
  }
}

// 4) 清理
if (dead.length) {
  if (!PRUNE) {
    console.log(`\n有 ${dead.length} 个条目已失效。加 --prune 删除（会先备份）。`);
  } else {
    const kept = all.filter((m) => !(m.vendor === 'intern-ai' && dead.some((d) => d.id === m.id)));
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const backup = `${TARGET}.bak-prune-${stamp}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    const tmp = TARGET + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
    fs.renameSync(tmp, TARGET);
    console.log(`\n已删除 ${dead.length} 个失效条目，备份 ${path.basename(backup)}`);
    console.log(`models.json: ${all.length} → ${kept.length} 个`);
    console.log('重启 WorkBuddy 后生效。');
  }
} else {
  console.log('\n结论：全部可用，无需清理。');
}

if (!alive.length && !dead.length) {
  console.log('没有可检查的条目。');
}

function pruneAll(reason) {
  const kept = all.filter((m) => m.vendor !== 'intern-ai');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backup = `${TARGET}.bak-prune-${stamp}`;
  if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
  const tmp = TARGET + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
  fs.renameSync(tmp, TARGET);
  console.log(`\n已删除全部 ${mine.length} 个 intern-ai 条目（${reason}），备份 ${path.basename(backup)}`);
  console.log(`models.json: ${all.length} → ${kept.length} 个`);
  console.log('重启 WorkBuddy 后生效。');
}
