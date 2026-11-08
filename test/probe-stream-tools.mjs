/**
 * 探测：流式（SSE）下的工具调用分片能否重组
 * 用法: node test/probe-stream-tools.mjs [model]
 */
const model = process.argv[2] ?? 'GLM-5.3-Flash';
const base = (process.argv[3] ?? 'http://127.0.0.1:8787/v1').replace(/\/+$/, '');
const key = process.argv[4] ?? process.env.GW_KEY ?? '';
if (!key) {
  console.error('缺少 api key。用法: node test/probe-stream-tools.mjs [model] [baseUrl] <apiKey>');
  console.error('或先设置环境变量 GW_KEY=sk-gw-xxx');
  process.exit(1);
}

const body = {
  model,
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: '读一下 package.json 的内容。必须调用工具。' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件路径' } },
          required: ['path'],
        },
      },
    },
  ],
  tool_choice: 'auto',
};

const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180_000),
});

if (!res.ok) {
  console.log(`HTTP ${res.status}`, (await res.text()).slice(0, 300));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let chunks = 0;
let content = '';
const calls = []; // {index, name, args}
let usage = null;
let done = false;

while (true) {
  const { value, done: eof } = await reader.read();
  if (eof) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (p === '[DONE]') {
      done = true;
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(p);
    } catch {
      continue;
    }
    chunks++;
    if (obj.usage) usage = obj.usage;
    const delta = obj.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      calls[idx] ??= { name: '', args: '' };
      if (tc.function?.name) calls[idx].name = tc.function.name;
      if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
    }
  }
}

console.log(`model=${model}  SSE chunk 数=${chunks}  [DONE]=${done}`);
console.log('content:', content.slice(0, 120) || '(空)');
const valid = calls.filter(Boolean);
console.log('重组出的 tool_calls:', valid.length);
for (const c of valid) {
  let parsed = null;
  try {
    parsed = JSON.parse(c.args);
  } catch {
    /* ignore */
  }
  console.log(`  → ${c.name}(${c.args})  JSON可解析=${Boolean(parsed)}`);
}
console.log('usage:', JSON.stringify(usage));

if (!valid.length) {
  console.log('\n结论：流式下没有 tool_calls，agent 客户端可能无法工作。');
  process.exit(2);
}
if (!valid.every((c) => c.name && JSON.parse(c.args ?? '{}'))) {
  console.log('\n结论：tool_calls 分片不完整/参数非法。');
  process.exit(3);
}
console.log('\n结论：流式工具调用可正常重组。');
