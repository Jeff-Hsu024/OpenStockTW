@echo off
setlocal
cd /d "%~dp0.."
set "OPENSTOCK_AGENT_ENABLE=true"
node scripts\agent-worker.mjs
