/**
 * 探测：上游是否支持 OpenAI 工具调用（function calling）
 * 用途：接入 agent 类客户端（WorkBuddy / Cline / Codex）前先验通
 * 用法: node test/probe-toolcall.mjs [model] [baseUrl] [apiKey]
 */
const model = process.argv[2] ?? 'GLM-5.3-Flash';
const base = (process.argv[3] ?? 'http://127.0.0.1:8787/v1').replace(/\/+$/, '');
const key = process.argv[4] ?? process.env.GW_KEY ?? '';
if (!key) {
  console.error('缺少 api key。用法: node test/probe-toolcall.mjs [model] [baseUrl] <apiKey>');
  console.error('或先设置环境变量 GW_KEY=sk-gw-xxx');
  process.exit(1);
}

const body = {
  model,
  messages: [{ role: 'user', content: '北京现在多少度？用工具查，不要猜。' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的当前天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ],
  tool_choice: 'auto',
  stream: false,
};

const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180_000),
});
const text = await res.text();
const ms = Date.now() - t0;

let json = null;
try {
  json = JSON.parse(text);
} catch {
  /* ignore */
}

console.log(`HTTP ${res.status}  ${ms}ms  model=${model}`);
if (!json) {
  console.log('非 JSON 响应:', text.slice(0, 300));
  process.exit(1);
}
if (json.error) {
  console.log('错误:', JSON.stringify(json.error));
  process.exit(1);
}

const msg = json.choices?.[0]?.message ?? {};
const calls = msg.tool_calls ?? [];
console.log('返回 model:', json.model);
console.log('content:', (msg.content ?? '').slice(0, 150) || '(空)');
console.log('tool_calls:', calls.length);
for (const c of calls) {
  console.log(`  → ${c.function?.name}(${c.function?.arguments})`);
}
console.log('usage:', JSON.stringify(json.usage));

if (!calls.length) {
  console.log('\n结论：没有返回 tool_calls。agent 类客户端大概率不可用。');
  process.exit(2);
}
console.log('\n结论：工具调用可用。');
