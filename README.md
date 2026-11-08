# 本地模型中转网关（LLM Gateway）

把上游模型 API（DeepSeek / 通义 / OpenAI 兼容接口…）收拢到一个自建入口，实现两件事：

1. **给每个 agent 发独立 key**，按 agent 统计用量、设配额（token / 次数 / 金额）、限流（RPM / TPM / 并发）、限定可用模型。
2. **给调用方一个通用 key**，任何程序拿着它直接调，无需知道真实上游 key。

零第三方依赖，单进程 Node，数据落在本地文件。默认只监听 `127.0.0.1`。

> 想把 **Qoder 的订阅额度**也反代出来一起管？看 [第八节](#八反代-qoder-额度可选)——要额外挂一个协议转换器，因为 Qoder 不是 OpenAI 兼容接口。

---

## 一、核心架构

```
调用方 (agent / 脚本 / 客户端)
        │  Authorization: Bearer sk-gw-xxx        ← 网关自己的 key，不是上游 key
        ▼
┌─────────────────────────────────────────────────────────┐
│ 本地中转网关  src/server.mjs                              │
│                                                          │
│  ① 鉴权 auth.mjs        key → SHA256 → 查 client         │
│  ② 路由 proxy.mjs       model 名 glob → provider         │
│  ③ 配额 auth.mjs        台账 + 预估 → 放行 / 429          │
│  ④ 限流 ratelimit.mjs   令牌桶 RPM + 滑窗 TPM + 并发闸门   │
│  ⑤ 转发 proxy.mjs       换上游 key，流式边转发边解析 usage │
│  ⑥ 计量 metering.mjs    usage → token / 成本             │
│  ⑦ 记账 store.mjs       JSONL 台账 + 聚合快照             │
└─────────────────────────────────────────────────────────┘
        │  Authorization: Bearer <上游 apiKey>
        ▼
   上游 provider（baseUrl 可配多个）
```

一次请求的完整链路：

```
收到请求 → 鉴权 → 读 body → 模型白名单 → 选 provider → 配额预检 → 限流 → 转发
       → 响应透传（含 SSE 流） → 解析 usage → 算成本 → 写台账 → 回写额度响应头
```

任何一步失败都会**写一条台账记录**（status 4xx/5xx，token 记 0），所以台账里的请求数包含被拒的请求——这是有意的，被拒的请求同样消耗资源。

### 目录

```
本地模型中转网关/
├─ config.json              主配置（含密钥，别提交到公开仓库）
├─ 启动网关.ps1 / .bat       启动脚本
├─ src/
│  ├─ server.mjs            HTTP 入口、代理链路编排、优雅退出
│  ├─ config.mjs            配置加载/校验、key 哈希、glob 匹配
│  ├─ auth.mjs              鉴权、配额判定、模型白名单
│  ├─ ratelimit.mjs         RPM/TPM/并发限流
│  ├─ proxy.mjs             上游转发（流式 + 非流式）
│  ├─ metering.mjs          usage 归一化、估算、计价
│  ├─ store.mjs             台账 + 快照 + 聚合
│  ├─ admin.mjs             /admin/* 管理接口
│  └─ cli.mjs               命令行（查额度、加 agent、看日志）
├─ test/
│  ├─ mock-upstream.mjs     模拟上游
│  ├─ config.test.json      测试配置
│  └─ smoke.mjs             端到端测试（34 项）
└─ data/                    运行时生成
   ├─ ledger.jsonl          每请求一行（追加写）
   ├─ snapshot.json         聚合用量快照（原子写）
   └─ clients.runtime.json  运行时通过管理接口新增的 key
```

---

## 二、配置文件结构

```jsonc
{
  "server": {
    "host": "127.0.0.1",          // 只想本机用就别改；要局域网共享改 0.0.0.0
    "port": 8787,
    "adminToken": "至少8位",       // 管理接口口令，务必换掉
    "maxBodyBytes": 10485760,     // 请求体上限 10MB
    "requestTimeoutMs": 180000,   // 兜底超时
    "trustProxy": false           // 在反向代理后面才设 true（读 X-Forwarded-For）
  },

  "proxy": {
    "basePath": "/v1",            // 对外路径前缀，客户端 base_url 填 http://127.0.0.1:8787/v1
    "currency": "CNY",            // 只影响展示
    "injectStreamUsage": true,    // 流式请求自动补 stream_options.include_usage，否则拿不到 token 数
    "estimateCharsPerToken": 3.5  // 上游不返回 usage 时按字符数估算
  },

  "providers": {                  // 上游定义，可以配任意多个
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-你的真实上游key",
      "timeoutMs": 180000,
      "headers": {}               // 附加请求头，如 {"x-app":"gateway"}
    }
  },

  "routes": [                     // 按顺序匹配 model 名，第一个命中的 provider 生效
    { "match": "qwen-*", "provider": "dashscope" },
    { "match": "deepseek-*", "provider": "deepseek" },
    { "match": "*", "provider": "deepseek" }   // 兜底
  ],

  "pricing": {                    // 每 100 万 token 的价格，仅用于算钱
    "deepseek-chat": { "in": 2, "out": 8 },
    "*": { "in": 2, "out": 8 }
  },

  "clients": [                    // 调用方 = 一个 key = 一份配额
    {
      "id": "agent-researcher",   // 唯一，台账里的统计维度
      "name": "调研 Agent",
      "type": "agent",            // agent | generic，仅语义标签，规则完全一致
      "key": "sk-gw-xxx",         // 明文；也可写 "keyHash": "<sha256>"
      "enabled": true,
      "quota": {
        "period": "daily",        // total(一次性) | daily | monthly
        "tokens": 200000,         // 三个维度都可选，不写=不限
        "requests": 2000,
        "cost": 5
      },
      "limits": {
        "rpm": 60,                // 每分钟请求数
        "tpm": 60000,             // 每分钟 token
        "maxConcurrent": 4        // 同时进行中的请求
      },
      "models": {
        "allow": ["deepseek-*"],  // glob；["*"] 表示全部
        "deny": ["deepseek-reasoner"]   // 可选，优先级高于 allow
      }
    }
  ]
}
```

> `key` 建议直接用明文写方便查看；想更安全就生成 `sha256:` 形式只存哈希（哈希后无法反推，但也没法在配置里看到 key 本身）。

---

## 三、四件事分别怎么处理的

### 鉴权

- 取 `Authorization: Bearer <key>`（也接受 `x-api-key`、`x-gw-key`）。
- key 做 SHA-256 → 在内存索引 `Map<hash, client>` 里查。配置文件里存明文也会先哈希再入索引，HashMap 里没有明文 key。
- 失败一律返回 OpenAI 风格错误体：
  ```json
  { "error": { "message": "鉴权失败: invalid_key", "type": "authentication_error" } }
  ```
  缺 key → 401，key 不存在 → 401，client 被停用 → 403。
- 转发前**剥掉客户端的 Authorization**，换成 provider 的 apiKey。上游 key 永不外泄。

### 额度计量

- **口径**：以 token 为主，同时记成本（token × 价格表）和请求次数。
- **数据从哪来**：
  - 非流式：直接读上游响应 JSON 的 `usage`。
  - 流式：网关自动给请求补 `stream_options.include_usage`，然后一边转发一边扫 SSE，取最后含 `usage` 的那个 chunk。
  - 上游不给 usage：按 `字符数 ÷ estimateCharsPerToken` 估算，台账标记 `estimated: true`。
- **归一化**：`prompt_tokens/input_tokens`、`completion_tokens/output_tokens`、`cache_read_input_tokens` 都统一成一个结构，所以 OpenAI / DeepSeek / Anthropic 风格都能算。
- **周期**：台账里对每个请求**同时**累加 `all`、`daily`、`monthly` 三个桶。所以事后把 `quota.period` 从 daily 改成 monthly，历史数据立刻可用，不用重算。
- **预检 + 兜底**：请求进上游之前，用「已用 + 本次 prompt 预估」判断是否超限，超了直接 429，不浪费上游调用；请求结束后按**实际** usage 入账。所以最后一次请求可能略微超出上限（上游返回的 token 数事前不可知），这是所有网关的共同做法。
- **响应头**：每次成功响应都带 `x-gw-quota-tokens-remaining`、`x-gw-quota-period`，调用方自己就能感知余量。

### 转发路由

- 客户端请求 `POST /v1/chat/completions` → 网关取 `model` 字段 → 按 `routes` 顺序做 glob 匹配 → 命中 provider → 拼成 `baseUrl + /chat/completions`。
- 路径**原样透传**（`/v1/models`、`/v1/embeddings` 也能用），不硬编码接口列表。
- 流式：`for await (chunk of upstream.body)` 逐块写回，不缓冲，首字节延迟接近直连。客户端断开时 `AbortController` 会同时掐掉上游连接，不产生僵尸请求。
- 上游 4xx/5xx 原样透传状态码和响应体，额外加 `x-gw-provider` 头便于排查。

### 日志记录

两层，分开看：

**① 控制台**（人看）
```
[ok] 14:42:03 agent-researcher deepseek-chat 200 128/512t 1832ms stream gw_a1b2c3
```
`状态 时间 调用方 模型 HTTP码 输入/输出token 耗时 流式 请求ID`

**② 台账 `data/ledger.jsonl`**（机器看，一行一条）
```json
{"ts":"2026-11-08T06:42:03.117Z","reqId":"gw_a1b2c3","kind":"request",
 "clientId":"agent-researcher","model":"deepseek-chat","provider":"deepseek",
 "status":200,"stream":true,"tokensIn":128,"tokensOut":512,"tokens":640,
 "cached":0,"cost":0.004352,"latencyMs":1832,"ttfbMs":410,
 "clientIp":"127.0.0.1","ua":"openai-python/1.30","periodKeys":["all","2026-11-08","2026-11"]}
```

- **不记请求体、不记响应体、不记任何 key**，只记计量所需的元数据。
- 写入策略：`record()` 先进内存缓冲 + 更新聚合，1.5 秒后批量 `appendFileSync`，同时把聚合写 `snapshot.json`（写 `.tmp` 再 rename，避免半截文件）。
- 启动时：读快照 → 从快照记录的字节偏移续读台账增量。台账被截断/轮转会检测到并全量重放。
- 清理：`data/ledger.jsonl` 是纯文本，可以直接按月切分归档，删掉旧文件不影响 `snapshot.json` 里的累计值（但会导致下次启动全量重放，所以删之前先确认快照之后的增量已合并）。

---

## 四、部署与启动

### 环境

Node.js ≥ 18（你机器上是 v22，够用）。无需 `npm install`。

### 1. 填配置

仓库里没有 `config.json`（真实配置含密钥，不提交）。先复制一份：

```powershell
Copy-Item config.example.json config.json
```

再编辑 `config.json`：

```jsonc
"providers": {
  "deepseek": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-你的key" }
}
```

顺手把 `server.adminToken` 换成自己的（8 位以上随机串），把 `clients[].key` 换成你自己的 key（建议 `sk-gw-` + 随机串，随便生成）。

### 2. 启动

```powershell
# 方式一：脚本
pwsh -File .\启动网关.ps1

# 方式二：直接跑
node src/server.mjs --config config.json

# 换端口
node src/server.mjs --config config.json --port 9000
```

看到下面这块就是起来了：

```
本地模型中转网关已启动
  监听      http://127.0.0.1:8787
  代理前缀  /v1
```

### 3. 验证

```powershell
curl.exe -s http://127.0.0.1:8787/v1/chat/completions `
  -H "Authorization: Bearer sk-gw-你的key" `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'
```

### 4. 调用方接入

任何 OpenAI 兼容客户端，只改两处：

```
base_url = http://127.0.0.1:8787/v1
api_key  = sk-gw-xxx          # 网关发的 key，不是上游 key
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-gw-xxx")
print(client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
))
```

```js
const r = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'authorization': 'Bearer sk-gw-xxx', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }),
});
```

---

## 五、日常管理

### 命令行（推荐）

```powershell
node src/cli.mjs status              # 服务与总量
node src/cli.mjs clients             # 所有调用方 + 用量进度条
node src/cli.mjs usage agent-researcher
node src/cli.mjs log -n 20           # 最近 20 条台账
node src/cli.mjs add agent-writer --name "写作Agent" --tokens 500000 --period monthly --rpm 30
node src/cli.mjs patch agent-writer --tokens 1000000
node src/cli.mjs patch agent-writer --disable
node src/cli.mjs reset agent-writer  # 清零用量（不删历史台账）
node src/cli.mjs rm agent-writer
node src/cli.mjs reload              # 改完 config.json 不用重启
```

`add` 会打印一次明文 key，**只返回这一次**，请立刻记下。

### HTTP 接口

全部要 `Authorization: Bearer <adminToken>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/admin/status` | 运行状态、全局累计 |
| GET | `/admin/clients` | 所有调用方及用量 |
| POST | `/admin/clients` | 新增（返回明文 key） |
| PATCH | `/admin/clients/:id` | 改配额/限流/启停/key |
| DELETE | `/admin/clients/:id` | 删除 |
| POST | `/admin/clients/:id/reset` | 清零用量 |
| GET | `/admin/usage?client=xxx` | 用量明细（含按模型分布） |
| GET | `/admin/ledger?limit=50` | 最近台账 |
| POST | `/admin/reload` | 重载配置 |
| GET | `/health` | 无鉴权健康检查 |

运行时新增的 client 会写到 `data/clients.runtime.json`，重启后自动叠加，不会污染 `config.json`。

---

## 六、测试

```powershell
npm test          # 起模拟上游 + 网关，跑 34 项端到端断言
```

覆盖：鉴权、透传、流式 SSE、usage 解析、成本计算、配额耗尽、RPM 限流、模型白名单、运行时创建 key、停用生效、台账字段、上游错误、重启后用量恢复。

---

## 七、注意事项

- **默认只监听 127.0.0.1**。改成 `0.0.0.0` 共享给局域网前想清楚：网关里存着上游 key，谁连上谁能用。
- **adminToken 泄露 = 所有 key 失控**，别写在会被提交的文件里；可用环境变量 `GW_ADMIN_TOKEN` 覆盖。
- **配额是软上限**：最后一次请求可能超额（上游 token 数事前不可知）。要硬拦就把 `tokens` 设得比预期低一点，或用 `max_tokens` 限制单次输出。
- **限流是进程内状态**，重启归零。单实例没问题；多实例部署要换 Redis。
- **成本是估算**：按 `pricing` 表算，和账单对不上就改表。缓存命中按 0.2 折，可用 `cachedIn` 覆盖。
- **时区**用系统本地时间切日/月，和账单周期可能差几小时。

---

## 八、反代 Qoder 额度（可选）

Qoder 的后端**不是** OpenAI 兼容协议，走私有 `COSY`（自定义 base64 + RSA/AES 会话 + 逐请求签名），端点 `api3.qoder.sh` / 国内网关，请求体是 `agent_chat_generation` 私有 schema。所以不能直接把它当 provider 指过去，中间必须有一层协议翻译。

本方案用社区现成实现 [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)（MIT，纯 Python 标准库）做翻译，网关只管额度：

```
客户端(OpenAI 协议)  →  8787 网关（鉴权/配额/credits/台账）  →  8790 桥接（COSY 签名 + schema 转换）  →  Qoder 官方
```

### 启动

```powershell
cd "C:\Users\Administrator\Desktop\AI创作作品\本地模型中转网关"
pwsh -File .\启动全部.ps1
```

会依次起桥接（8790）和网关（8787）。桥接已在运行时自动跳过。

桥接的看板在 `http://127.0.0.1:8790/`，默认密码 `admin`，**第一件事是改掉它**。

### 账号

已从本机 Qoder 客户端导入（`%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，只读扫描后手动确认导入）。

新增账号在看板「账号」页：
- **扫描本地凭证** —— 再点一次就能补上别的账号
- **OAuth 设备授权** —— 浏览器登录，最稳
- **导入 PAT** —— 网页版「设置 → Personal Access Token」建的 `pt-` 令牌

凭证以明文存在 `vendor/qoder2api-hub-main/accounts/`，别把这个目录打包发人。

Token 生命周期：`dt-` 约 30 天、`drt-` refresh 约 1 年，桥接会自动刷新；连续失败才会标记「需重新登录」。

### 可用模型（13 个）

```
Auto  Fast  QoDuck
Qwen3.8-Max  Qwen3.8-Flash
DeepSeek-V4-Pro  DeepSeek-Flash
GLM-5.3  GLM-5.3-Flash
Kimi-K3.1-Pro  Kimi-K2.8-Preview
MiniMax-M3.1-Flash  Step-5-Preview
```

`routes` 里已按模型名精确映射到 `qoder` provider，注意这几条**必须排在 `deepseek-*` 通配之前**，否则 `DeepSeek-V4-Pro` 会被当成 DeepSeek 官方模型发出去。

### credits 计量

Qoder 按 **credits** 计费，`usage` 里直接给 `credits` 字段。网关为此加了一个独立的计量维度：

```jsonc
"quota": { "period": "daily", "credits": 5, "requests": 500 }
```

台账每行带 `credits` 字段，CLI 单独显示：

```
额度credits 0.053181 / 5  █░░░░░░░░░░░░░░░ 1%
```

`pricing` 里 Qoder 模型全部配 `{ "in": 0, "out": 0 }`，让金额维度不参与（它的成本就是 credits）。如果你想知道 credits 折算成多少钱，往 `pricing` 里填等效单价即可。

单次典型消耗：一次短问答约 `0.009 ~ 0.045` credits（大头是 Qoder 内部的 baseprompt 模板，约 2400~2600 token）。缓存命中时显著更低——所以别频繁换 system prompt，会打掉缓存。

### 三点风险

- **条款**：PAT 是官方给「集成」用的，拿去喂 Claude Code / Codex 这类第三方客户端可能踩 Qoder 的服务条款，最坏是封号。自己判断。
- **风控**：桥接有排队闸门和请求节奏控制，多账号也只是缓解不能根除；高频并发会触发上游拒绝，`/health` 里能看到排队和限流信号。
- **版本**：Qoder 改协议时桥接要跟着更新（`qoder_updater.py` 有一键更新）。更新失败就把仓库删了重新拉。

### 卸载

```powershell
# 停桥接
cmd /c "vendor\qoder2api-hub-main\stop-qoder-proxy.bat"
# 删干净（含凭证）
Remove-Item -Recurse -Force vendor
```

---

## 九、接入 WorkBuddy 客户端

WorkBuddy 的自定义模型存在 `~/.workbuddy/models.json`，是 OpenAI 兼容端点数组。往里加条目就能把 Qoder 的模型挂到它的模型选择器里。

### 注册

```powershell
cd "C:\Users\Administrator\Desktop\AI创作作品\本地模型中转网关"
node scripts/install-workbuddy-models.mjs --key sk-gw-你的key
```

脚本只追加 `vendor: "qoder"` 的条目，不动你已有的模型；写之前自动备份成 `models.json.bak-qoder-<日期>`。加 `--dry` 可以只预演不写。

已注册的 5 个（都指向 `http://127.0.0.1:8787/v1`）：

| 显示名 | model id | 上下文 | price_factor | 用途 |
|---|---|---|---|---|
| Qoder · GLM-5.3-Flash | `GLM-5.3-Flash` | 1,000,000 | 0.1 | 主力，长上下文 agent |
| Qoder · Qwen3.8-Flash | `Qwen3.8-Flash` | 180,000 | 0 | 最省 credits |
| Qoder · DeepSeek-V4-Pro | `DeepSeek-V4-Pro` | 96,000 | 0.5 | 强推理 |
| Qoder · Kimi-K2.8-Preview | `Kimi-K2.8-Preview` | 180,000 | 0.8 | 长文 |
| Qoder · Auto | `Auto` | 200,000 | 0.5 | 官方自动路由 |

`price_factor` 是 Qoder 内部的价格倍率——0 免费、0.1 很便宜、1.4 最贵（Kimi-K3）。选模型前先看这个数。

### 生效

**必须重启 WorkBuddy**（改完 models.json 不会热加载），重启会断开当前会话。

重启前先确认两个服务在跑：

```powershell
pwsh -File .\启动全部.ps1
```

### 能力边界

- ✅ 流式输出、工具调用（含流式下 `tool_calls` 分片重组，已实测）
- ❌ 图片输入（`supportsImages: false`，桥接不转 image 格式，开了会报错）
- ❌ 思考档位（`supportsReasoning: false`，避免客户端发 `reasoning_effort` 参数被上游拒）
- ⚠️ 每次请求都带 Qoder 的 baseprompt（约 2400~2600 token），token 数看着偏大是正常的，不是网关重复计费

### 自测

```powershell
# 工具调用（非流式）
node test/probe-toolcall.mjs GLM-5.3-Flash
# 工具调用（流式分片重组）
node test/probe-stream-tools.mjs GLM-5.3-Flash
```

两个都要看最后一行「结论：…可用」。如果失败，先查桥接 `/health` 和网关台账。

### 回滚

WorkBuddy 升级或重装可能覆盖 `models.json`，表现为模型列表里的 Qoder 条目消失。两种情况：

```powershell
# 重跑注册脚本即可
node scripts/install-workbuddy-models.mjs --key sk-gw-...

# 彻底撤掉，恢复原样
Copy-Item "$env:USERPROFILE\.workbuddy\models.json.bak-qoder-20261108" "$env:USERPROFILE\.workbuddy\models.json" -Force
```

回滚后同样要重启 WorkBuddy。


