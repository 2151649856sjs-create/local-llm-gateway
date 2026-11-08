# 停止中转网关与 Qoder 桥接
# 用法: pwsh -File .\停止网关.ps1

param([int]$Port = 8787, [int]$BridgePort = 8790)

$killed = @()
foreach ($p in @($Port, $BridgePort)) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        try {
            Stop-Process -Id $conn.OwningProcess -Force
            $killed += "$p (pid $($conn.OwningProcess))"
        } catch {
            Write-Host "端口 $p 停止失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

if ($killed.Count -eq 0) {
    Write-Host "两个端口都没有监听，本来就没在跑。" -ForegroundColor DarkGray
} else {
    Write-Host "已停止: $($killed -join '  ')" -ForegroundColor Green
}
