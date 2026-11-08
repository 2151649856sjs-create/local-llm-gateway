/**
 * 模拟上游（OpenAI 兼容），仅用于测试
 * node test/mock-upstream.mjs [port]
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 9999);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (url.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('pong');
    }
    if (req.headers.authorization !== 'Bearer sk-mock-upstream') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad upstream key' } }));
    }

    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
    }

    if (url.pathname.endsWith('/fail')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }

    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* ignore */
    }
    const promptTokens = Math.max(5, Math.ceil(raw.length / 4));
    const completionTokens = 12;
    const model = body.model ?? 'mock-1';

    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const words = ['你好', '，', '这是', '一条', '流式', '回复'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) {
          res.write(
            `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: words[i] } }] })}\n\n`,
          );
          i++;
        } else {
          clearInterval(timer);
          if (body.stream_options?.include_usage) {
            res.write(
              `data: ${JSON.stringify({
                id: 'c1',
                object: 'chat.completion.chunk',
                model,
                choices: [],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
              })}\n\n`,
            );
          }
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 30);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '这是模拟回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[mock] upstream on http://127.0.0.1:${port}/v1`));
