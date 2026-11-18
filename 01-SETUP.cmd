@echo off
setlocal
chcp 65001 >nul
title Nurse Bot - Settings
cd /d "%~dp0"
if errorlevel 1 goto failed
where node >nul 2>&1
if errorlevel 1 goto no_node
node scripts\local.mjs setup
set "BOT_EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %BOT_EXIT_CODE%
:no_node
echo Please install Node.js 24 LTS from https://nodejs.org/en/download
echo Then reopen this file.
:failed
pause
exit /b 1

