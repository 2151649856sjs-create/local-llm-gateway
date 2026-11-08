@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\server.mjs --config config.json
if errorlevel 1 pause
