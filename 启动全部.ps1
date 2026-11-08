# 一键启动中转网关（含 Qoder 桥接看护 + 崩溃自动重启）
#
# 用法：
#   pwsh -File .\启动全部.ps1              # 前台运行，Ctrl+C 停止
#   pwsh -File .\启动全部.ps1 -Detached    # 后台窗口运行，关掉当前终端也不影响
#   pwsh -File .\启动全部.ps1 -Status      # 只看状态
#
# 桥接（8790）由网关自己拉起并看护，不需要单独启动。

param(
    [int]$Port = 8787,
    [switch]$Detached,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Test-Port([int]$p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return [bool]$c
}

function Get-GwHealth([int]$p) {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$p/health" -TimeoutSec 3 -NoProxy -ErrorAction Stop
    } catch { return $null }
}

if ($Status) {
    $h = Get-GwHealth $Port
    if (-not $h) { Write-Host "网关未运行（端口 $Port 无响应）" -ForegroundColor Red; exit 1 }
    Write-Host "网关     运行中  端口 $Port  已跑 $($h.uptimeSec) 秒" -ForegroundColor Green
    if ($h.bridge) {
        $bh = if ($h.bridge.healthy) { "正常" } else { "不通" }
        $color = if ($h.bridge.healthy) { "Green" } else { "Red" }
        Write-Host "桥接     $bh  $($h.bridge.mode)  pid=$($h.bridge.pid)  重启 $($h.bridge.restarts) 次" -ForegroundColor $color
    } else {
        Write-Host "桥接     未启用" -ForegroundColor DarkGray
    }
    Write-Host "调用方   $($h.clients) 个    上游 $($h.providers -join ', ')" -ForegroundColor DarkGray
    exit 0
}

if (Test-Port $Port) {
    $h = Get-GwHealth $Port
    if ($h) {
        Write-Host "网关已在运行（端口 $Port，已跑 $($h.uptimeSec) 秒），不重复启动。" -ForegroundColor Yellow
        if ($h.bridge) {
            $bh = if ($h.bridge.healthy) { "正常" } else { "不通（网关会自动重启它）" }
            Write-Host "桥接: $bh" -ForegroundColor DarkGray
        }
        exit 0
    }
    Write-Host "端口 $Port 被占用但不应答 HTTP，可能有残留进程。" -ForegroundColor Red
    Write-Host "先执行: Get-NetTCPConnection -LocalPort $Port -State Listen | Select OwningProcess" -ForegroundColor DarkGray
    exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "找不到 Node.js，请先装 Node 18+" -ForegroundColor Red; exit 1 }

$runner = Join-Path $root "scripts\run-gateway.ps1"

if ($Detached) {
    Start-Process -FilePath "pwsh" -ArgumentList @("-NoExit", "-File", "`"$runner`"", "-Port", "$Port") -WorkingDirectory $root
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $h = Get-GwHealth $Port
        if ($h) {
            Write-Host "网关已启动  http://127.0.0.1:$Port" -ForegroundColor Green
            if ($h.bridge) { Write-Host "桥接: $($h.bridge.mode) pid=$($h.bridge.pid)" -ForegroundColor DarkGray }
            exit 0
        }
    }
    Write-Host "启动超时，去新开的窗口看报错。" -ForegroundColor Red
    exit 1
}

& $runner -Port $Port
