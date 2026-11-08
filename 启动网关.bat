@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地模型中转网关
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "scripts\run-gateway.ps1" -Port 8787
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run-gateway.ps1" -Port 8787
)
echo.
echo 网关已退出，按任意键关闭窗口。
pause >nul
