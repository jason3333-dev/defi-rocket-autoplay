@echo off
cd /d "%~dp0"
npm run inspect -- --browser edge --click-to-capture
pause
