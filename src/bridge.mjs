/**
 * 桥接子进程看护（supervisor）
 *
 * 背景：Qoder 桥接（vendor/qoder2api-hub-main/qoder_proxy.py）是独立进程，
 * 一旦它挂掉而网关还活着，所有走 qoder provider 的请求都会变成 502，
 * 客户端只能看到笼统的"网络异常"。这里让网关自己把桥接拉起来并盯着它。
 *
 * 行为：
 *   1. 启动时先探活；外部已在跑就只监控，不重复拉起（不抢端口）
 *   2. 子进程 stdout/stderr 转发到网关控制台，保留尾部用于报错
 *   3. 每 intervalMs 探活；连续 failThreshold 次失败 → 杀掉重启
 *   4. 重启有退避与次数上限，避免无限 crash 循环刷屏
 *   5. 网关退出时一并杀掉子进程
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROXY_ENV = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];

/** 子进程环境：必须摘掉代理变量，否则桥接访问 Qoder 会被沙箱代理带偏 */
function childEnv() {
  const env = { ...process.env };
  for (const k of PROXY_ENV) delete env[k];
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

async function probe(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

function tail(lines, n = 12) {
  return lines.slice(-n).map((l) => `    ${l}`).join('\n');
}

export function createBridgeSupervisor({ cfg, root, log = console.log, warn = console.warn }) {
  const b = cfg.bridge ?? {};
  const enabled = b.enabled !== false && Boolean(b.command);
  if (!enabled) return { enabled: false, info: () => ({ enabled: false }), start: async () => {}, stop: () => {} };

  const cwd = path.resolve(root, b.cwd ?? '.');
  const args = b.args ?? [];
  const healthUrl = b.healthUrl ?? 'http://127.0.0.1:8790/health';
  const intervalMs = b.watchIntervalMs ?? 15_000;
  const failThreshold = b.failThreshold ?? 2;
  const startupTimeoutMs = b.startupTimeoutMs ?? 40_000;
  const restartDelayMs = b.restartDelayMs ?? 3_000;
  const maxRestarts = b.maxRestarts ?? 10;
  const restartWindowMs = b.restartWindowMs ?? 10 * 60_000;

  let child = null;
  let timer = null;
  let fails = 0;
  let external = false;
  let stopping = false;
  let healthy = null; // 最近一次探活结果，供 /health 同步读取
  let restarts = [];
  let restartTimer = null;
  const ring = [];
  let generation = 0;

  const push = (line) => {
    for (const part of String(line).split(/\r?\n/)) {
      const t = part.trimEnd();
      if (!t) continue;
      ring.push(t);
      if (ring.length > 200) ring.shift();
    }
  };

  function attach(c) {
    c.stdout?.setEncoding('utf8');
    c.stderr?.setEncoding('utf8');
    c.stdout?.on('data', (d) => {
      push(d);
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(`  [bridge] ${l}`);
    });
    c.stderr?.on('data', (d) => {
      push(d);
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(`  [bridge] ${l}`);
    });
    c.on('error', (e) => {
      push(`spawn error: ${e.message}`);
      warn(`[bridge] 子进程启动失败: ${e.message}`);
    });
    c.on('exit', (code, sig) => {
      if (stopping) return;
      push(`exit code=${code} sig=${sig}`);
      warn(`[bridge] 子进程退出（code=${code} sig=${sig}），${Math.round(restartDelayMs / 1000)}s 后重启`);
      child = null;
      scheduleRestart();
    });
  }

  function backoff() {
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < restartWindowMs);
    if (restarts.length >= maxRestarts) {
      warn(`[bridge] ${restartWindowMs / 60000} 分钟内已重启 ${restarts.length} 次，停止自动重启。修好后执行 node src/cli.mjs reload 或重启网关。`);
      return null;
    }
    return Math.min(restartDelayMs * Math.max(1, restarts.length), 30_000);
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    const delay = backoff();
    if (delay == null) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping) spawnChild().catch((e) => warn(`[bridge] 重启失败: ${e.message}`));
    }, delay);
    restartTimer.unref?.();
  }

  async function spawnChild() {
    if (child || stopping) return;
    const gen = ++generation;
    push(`spawn ${b.command} ${args.join(' ')} (cwd=${cwd})`);
    const c = spawn(b.command, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    attach(c);
    restarts.push(Date.now());

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (gen !== generation || child !== c) return;
      if (await probe(healthUrl)) {
        log(`[bridge] 已就绪 ${healthUrl}`);
        healthy = true;
        fails = 0;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    warn(`[bridge] ${startupTimeoutMs / 1000}s 内未就绪，最近输出：\n${tail(ring)}`);
    // 交给 watch 循环处理，连续失败会触发重启
  }

  async function watch() {
    if (stopping) return;
    // 外部托管的桥接：只探活，不重启（否则会抢端口）
    if (external) {
      healthy = await probe(healthUrl);
      if (!healthy) {
        fails++;
        if (fails >= failThreshold) {
          warn(`[bridge] 外部桥接已失联（${healthUrl}），请检查 8790 端口上的进程`);
          fails = 0;
        }
      } else fails = 0;
      return;
    }
    if (!child) return;
    healthy = await probe(healthUrl);
    if (healthy) {
      fails = 0;
      return;
    }
    fails++;
    if (fails >= failThreshold) {
      warn(`[bridge] 连续 ${fails} 次探活失败，重启桥接`);
      fails = 0;
      killChild();
      scheduleRestart();
    }
  }

  function killChild() {
    const c = child;
    child = null;
    generation++;
    if (!c || c.killed) return;
    try {
      c.kill();
    } catch {
      /* ignore */
    }
    // Windows 上 python 可能残留，兜底
    setTimeout(() => {
      try {
        if (c.exitCode == null) c.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000).unref?.();
  }

  async function start() {
    if (await probe(healthUrl)) {
      external = true;
      healthy = true;
      log(`[bridge] 检测到外部桥接已在运行（${healthUrl}），仅做健康监控`);
      timer = setInterval(watch, intervalMs);
      timer.unref?.();
      return;
    }
    if (!fs.existsSync(cwd)) {
      warn(`[bridge] 目录不存在，跳过: ${cwd}`);
      return;
    }
    if (b.command === 'python' && !whichPython()) {
      warn('[bridge] 找不到 python（PATH 里没有），跳过自动拉起；手动启动桥接后再用网关');
      return;
    }
    await spawnChild();
    timer = setInterval(watch, intervalMs);
    timer.unref?.();
  }

  function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    if (restartTimer) clearTimeout(restartTimer);
    killChild();
  }

  function info() {
    return {
      enabled: true,
      mode: external ? 'external' : child ? 'managed' : 'stopped',
      pid: child?.pid ?? null,
      healthUrl,
      healthy,
      restarts: restarts.length,
      lastOutput: ring.slice(-6),
    };
  }

  /** 不等待的探活刷新，供同步接口调用 */
  function refresh() {
    probe(healthUrl).then((ok) => {
      healthy = ok;
    }).catch(() => {});
  }

  return { enabled: true, start, stop, info, refresh, probe: () => probe(healthUrl) };
}

function whichPython() {
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, 'python' + ext))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}
