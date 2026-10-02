@echo off
rem Launcher GG-FunDriving 3D (web) — nyalain server dev + buka browser.
rem Close window ini = server mati.
cd /d "%~dp0..\webapp"
if not exist node_modules call npm install
start "" cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:5173/"
call npm run dev
