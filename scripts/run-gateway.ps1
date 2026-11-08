# 网关守护循环：进程退出后自动重启，直到手动 Ctrl+C
# 由 启动全部.ps1 调用，一般不直接跑。

param([int]$Port = 8787)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# 桥接与上游请求不能走系统/沙箱代理，否则会连不上 Qoder
foreach ($n in 'http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') {
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
}
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = "127.0.0.1,localhost"

$started = Get-Date
$failures = 0

while ($true) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 启动网关（端口 $Port）" -ForegroundColor Cyan
    & node src/server.mjs --config config.json --port $Port
    $code = $LASTEXITCODE
    $elapsed = ((Get-Date) - $started).TotalSeconds

    # 正常退出（Ctrl+C / 关机）不再重启
    if ($code -eq 0 -or $code -eq 130 -or $code -eq -1073741510) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 网关已停止（code=$code）" -ForegroundColor DarkGray
        break
    }

    # 跑过 60 秒才算"稳定过"，重置计数，避免偶发崩溃触发长退避
    if ($elapsed -gt 60) { $failures = 0 }
    $failures++
    $wait = [Math]::Min(3 * $failures, 30)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 网关异常退出（code=$code），${wait}s 后重启（连续第 $failures 次）" -ForegroundColor Yellow
    if ($failures -ge 8) {
        Write-Host "连续崩溃 8 次，可能是配置错误或端口被占用。停在这里等排查。" -ForegroundColor Red
        break
    }
    Start-Sleep -Seconds $wait
    $started = Get-Date
}
