/**
 * 计量存储：JSONL 台账（追加写）+ 聚合快照（原子落盘）
 * 设计取舍：本地自建、请求量级小，用文件而非数据库，零依赖、可 diff、可手工修。
 */
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  tokensIn: 0,
  tokensOut: 0,
  tokens: 0,
  cost: 0,
  credits: 0,
  requests: 0,
  errors: 0,
});

function add(acc, e) {
  acc.tokensIn += e.tokensIn ?? 0;
  acc.tokensOut += e.tokensOut ?? 0;
  acc.tokens += e.tokens ?? 0;
  acc.cost += e.cost ?? 0;
  acc.credits = (acc.credits ?? 0) + (e.credits ?? 0);
  acc.requests += 1;
  if (e.status >= 400) acc.errors += 1;
  return acc;
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.ledgerPath = path.join(dataDir, 'ledger.jsonl');
    this.snapshotPath = path.join(dataDir, 'snapshot.json');
    this.agg = {}; // clientId -> { total, periods, byModel }
    this.recent = []; // 最近 200 条，内存镜像
    this.ledgerBytes = 0;
    this.pendingLines = [];
    this.flushTimer = null;
    this.dirty = false;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let snap = null;
    if (fs.existsSync(this.snapshotPath)) {
      try {
        snap = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
        this.agg = snap.agg ?? {};
        this.ledgerBytes = snap.ledgerBytes ?? 0;
      } catch (e) {
        console.warn(`[store] 快照损坏，改为全量重放台账: ${e.message}`);
        snap = null;
      }
    }
    const size = fs.existsSync(this.ledgerPath) ? fs.statSync(this.ledgerPath).size : 0;

    let replayFrom = 0;
    if (snap && size >= this.ledgerBytes) {
      replayFrom = this.ledgerBytes; // 只回放增量
    } else if (snap) {
      // 台账被截断/轮转，快照失效
      console.warn('[store] 台账长度小于快照记录，忽略快照重放全量');
      this.agg = {};
      this.ledgerBytes = 0;
      replayFrom = 0;
    }

    if (size > 0) this.#replay(replayFrom);
    this.ledgerBytes = fs.existsSync(this.ledgerPath) ? fs.statSync(this.ledgerPath).size : 0;
    console.log(
      `[store] 已加载 ${Object.keys(this.agg).length} 个调用方用量，台账 ${(this.ledgerBytes / 1024).toFixed(1)} KB`,
    );
  }

  #replay(offset) {
    const fd = fs.openSync(this.ledgerPath, 'r');
    try {
      const len = fs.fstatSync(fd).size - offset;
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.#apply(JSON.parse(line), false);
        } catch {
          /* 跳过坏行 */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  #apply(e, keepRecent = true) {
    const id = e.clientId;
    if (!id) return;
    const slot = (this.agg[id] ??= { total: EMPTY(), periods: {}, byModel: {} });
    add(slot.total, e);
    for (const p of e.periodKeys ?? []) {
      slot.periods[p] ??= EMPTY();
      add(slot.periods[p], e);
    }
    if (e.model) {
      slot.byModel[e.model] ??= EMPTY();
      add(slot.byModel[e.model], e);
    }
    if (keepRecent) {
      this.recent.push(e);
      if (this.recent.length > 200) this.recent.shift();
    }
  }

  /** 写入一次请求记录（缓冲后批量刷盘） */
  record(entry) {
    const line = JSON.stringify(entry);
    this.pendingLines.push(line);
    this.#apply(entry);
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 1500);
      this.flushTimer.unref?.();
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingLines.length) {
      const chunk = this.pendingLines.join('\n') + '\n';
      fs.appendFileSync(this.ledgerPath, chunk, 'utf8');
      this.ledgerBytes += Buffer.byteLength(chunk);
      this.pendingLines = [];
    }
    if (this.dirty) {
      const tmp = this.snapshotPath + '.tmp';
      fs.writeFileSync(
        tmp,
        JSON.stringify({ updatedAt: new Date().toISOString(), ledgerBytes: this.ledgerBytes, agg: this.agg }),
        'utf8',
      );
      fs.renameSync(tmp, this.snapshotPath);
      this.dirty = false;
    }
  }

  /** 取某调用方某周期的用量 */
  usageOf(clientId, periodKeys) {
    const slot = this.agg[clientId];
    if (!slot) return { total: EMPTY(), periods: {}, byModel: {} };
    const periods = {};
    for (const p of periodKeys) periods[p] = slot.periods[p] ?? EMPTY();
    return { total: slot.total, periods, byModel: slot.byModel ?? {} };
  }

  /** 只读快照，避免调用方拿到可变引用后误改 */
  summary(clientId, periodKeys) {
    const u = this.usageOf(clientId, periodKeys);
    return {
      total: { ...u.total },
      periods: Object.fromEntries(Object.entries(u.periods).map(([k, v]) => [k, { ...v }])),
      byModel: Object.fromEntries(Object.entries(u.byModel ?? {}).map(([k, v]) => [k, { ...v }])),
    };
  }

  tail(n = 20) {
    return this.recent.slice(-n);
  }

  /** 清零某调用方（运维用，会写一条 kind=reset 的台账行） */
  reset(clientId, operator = 'admin') {
    this.agg[clientId] = { total: EMPTY(), periods: {}, byModel: {} };
    const entry = {
      ts: new Date().toISOString(),
      kind: 'reset',
      operator,
      clientId,
      status: 200,
      tokens: 0,
    };
    this.pendingLines.push(JSON.stringify(entry));
    this.dirty = true;
    this.flush();
  }
}
