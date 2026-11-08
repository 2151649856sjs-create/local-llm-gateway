/**
 * 把 Qoder 模型注册进 WorkBuddy 的自定义模型列表
 * 用法: node scripts/install-workbuddy-models.mjs [--url http://127.0.0.1:8787/v1] [--key sk-gw-xxx] [--dry]
 *
 * 行为：只追加/更新带 vendor="qoder" 的条目，不动已有模型。写前自动备份。
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
const BASE_URL = arg('url', 'http://127.0.0.1:8787/v1');
const API_KEY = arg('key', '');
const DRY = argv.includes('--dry');

if (!API_KEY) {
  console.error('缺少 --key（网关发的 sk-gw-... key）');
  process.exit(1);
}
if (!fs.existsSync(TARGET)) {
  console.error(`找不到 WorkBuddy 模型配置: ${TARGET}`);
  process.exit(1);
}

const WANTED = [
  {
    id: 'GLM-5.3-Flash',
    name: 'Qoder · GLM-5.3-Flash',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    note: '1M 上下文，factor 0.1，agent 主力',
  },
  {
    id: 'Qwen3.8-Flash',
    name: 'Qoder · Qwen3.8-Flash',
    maxInputTokens: 180_000,
    maxOutputTokens: 32_768,
    note: 'factor 0，最省 credits',
  },
  {
    id: 'DeepSeek-V4-Pro',
    name: 'Qoder · DeepSeek-V4-Pro',
    maxInputTokens: 96_000,
    maxOutputTokens: 32_768,
    note: '强推理，factor 0.5',
  },
  {
    id: 'Kimi-K2.8-Preview',
    name: 'Qoder · Kimi-K2.8-Preview',
    maxInputTokens: 180_000,
    maxOutputTokens: 32_768,
    note: '长文，factor 0.8',
  },
  {
    id: 'Auto',
    name: 'Qoder · Auto',
    maxInputTokens: 200_000,
    maxOutputTokens: 32_768,
    note: '官方自动路由，factor 0.5',
  },
];

const raw = fs.readFileSync(TARGET, 'utf8');
let list;
try {
  list = JSON.parse(raw);
} catch (e) {
  console.error(`models.json 解析失败: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(list)) {
  console.error('models.json 不是数组，格式与预期不符，已中止');
  process.exit(1);
}

const before = list.length;
let added = 0;
let updated = 0;

for (const w of WANTED) {
  const entry = {
    id: w.id,
    name: w.name,
    vendor: 'qoder',
    url: BASE_URL,
    apiKey: API_KEY,
    maxInputTokens: w.maxInputTokens,
    maxOutputTokens: w.maxOutputTokens,
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    tags: ['custom'],
  };
  const idx = list.findIndex((m) => m && m.id === entry.id && (m.vendor === 'qoder' || m.url === BASE_URL));
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
    updated++;
  } else {
    list.push(entry);
    added++;
  }
}

console.log(`目标文件: ${TARGET}`);
console.log(`原有 ${before} 个 → 新增 ${added}，更新 ${updated}，共 ${list.length} 个`);
for (const w of WANTED) console.log(`  + ${w.name.padEnd(30)} ${String(w.maxInputTokens).padStart(8)} ctx  ${w.note}`);

if (DRY) {
  console.log('\n--dry 模式，未写入。');
  process.exit(0);
}

// 备份
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backup = `${TARGET}.bak-qoder-${stamp}`;
if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
console.log(`\n已备份: ${path.basename(backup)}`);

// 原子写
const tmp = TARGET + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
fs.renameSync(tmp, TARGET);
console.log('已写入 models.json');
console.log('\n需要重启 WorkBuddy 才能在模型列表里看到（重启会断开当前会话）。');
