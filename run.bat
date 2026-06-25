@echo off
title Donation Action Hub
cd /d "%~dp0"
echo Starting Donation Action Hub...
echo Opening dashboard in your default browser...
start http://localhost:3000
node server.js
pause
