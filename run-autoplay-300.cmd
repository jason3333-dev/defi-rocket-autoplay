@echo off
cd /d "%~dp0"
npm run autoplay -- --max 200 --interval 25 --burst 12 --click-delay 0 --recent-ms 150
pause
