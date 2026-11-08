# 一键启动：Qoder 桥接(8790) + 中转网关(8787)
# 用法: pwsh -File .\启动全部.ps1
#       pwsh -File .\启动全部.ps1 -GatewayPort 9000 -BridgePort 8790

param(
    [int]$GatewayPort = 8787,
    [int]$BridgePort = 8790
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "`n=== 1/3 检查环境 ===" -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "缺 Node.js 18+" -ForegroundColor Red; exit 1 }
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Write-Host "缺 Python 3.9+" -ForegroundColor Red; exit 1 }
Write-Host "node   $node"
Write-Host "python $python"

Write-Host "`n=== 2/3 Qoder 桥接（端口 $BridgePort）===" -ForegroundColor Cyan
$bridgeUp = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$BridgePort/health" -TimeoutSec 3 -NoProxy -ErrorAction Stop
    $bridgeUp = $r.StatusCode -eq 200
} catch { $bridgeUp = $false }

if ($bridgeUp) {
    Write-Host "已在运行，跳过启动" -ForegroundColor Green
} else {
    $bat = Join-Path $root "vendor\qoder2api-hub-main\start-qoder-proxy.bat"
    if (-not (Test-Path $bat)) {
        Write-Host "找不到桥接脚本: $bat" -ForegroundColor Red
        Write-Host "请先解压 qoder2api-hub 到 vendor/ 目录" -ForegroundColor Red
        exit 1
    }
    Write-Host "启动中…"
    & cmd /c "`"$bat`" $BridgePort"
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$BridgePort/health" -TimeoutSec 2 -NoProxy -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $bridgeUp = $true; break }
        } catch { }
    }
    if (-not $bridgeUp) {
        Write-Host "桥接启动失败，看 vendor\qoder2api-hub-main\qoder-proxy.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "桥接就绪 http://127.0.0.1:$BridgePort" -ForegroundColor Green
    Write-Host "账号管理/看板: http://127.0.0.1:$BridgePort/  (默认密码 admin)" -ForegroundColor DarkGray
}

Write-Host "`n=== 3/3 中转网关（端口 $GatewayPort）===" -ForegroundColor Cyan
if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" | Out-Null }
Write-Host "按 Ctrl+C 停止网关（桥接会继续在后台跑）`n" -ForegroundColor DarkGray
& node src/server.mjs --config config.json --port $GatewayPort
