# 启动网关（PowerShell 7）
# 用法: pwsh -File .\启动网关.ps1
#       pwsh -File .\启动网关.ps1 -Port 9000

param(
    [int]$Port = 0,
    [string]$Config = "config.json"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "找不到 node，请先安装 Node.js 18+（https://nodejs.org）" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $Config)) {
    Write-Host "配置文件不存在: $Config" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "data")) {
    New-Item -ItemType Directory -Path "data" | Out-Null
}

$nodeArgs = @("src/server.mjs", "--config", $Config)
if ($Port -gt 0) { $nodeArgs += @("--port", "$Port") }

Write-Host "启动中… 按 Ctrl+C 停止（会先把台账落盘）" -ForegroundColor Cyan
& node @nodeArgs
