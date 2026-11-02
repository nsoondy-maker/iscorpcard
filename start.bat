@echo off
chcp 65001 >nul
echo 카카오 개발자 콘솔 JavaScript SDK 도메인에 http://localhost:5500 을 등록하세요.
start "" http://localhost:5500
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
