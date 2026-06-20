@echo off
cd /d "%~dp0"
npm run autoplay -- --max 200 --fast-dom --interval 12 --burst 40 --click-delay 0 --recent-ms 80
pause
