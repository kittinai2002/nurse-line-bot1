@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\import-cloud.mjs --apply
pause
