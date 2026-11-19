@echo off
setlocal
cd /d "%~dp0.."
if not exist ".next\BUILD_ID" (
  echo Missing production build. Run npm run build before enabling the scheduled task.
  exit /b 1
)
npm run start -- --hostname 127.0.0.1
