@echo off
rem p01-ballistic-viewer: start the local server (opens the browser by default).
rem   scripts\start.bat --game C:\path\to\p01-ballistic
rem or set P01_GAME first. Without a package it starts in replay-only mode.
setlocal
cd /d %~dp0..
python server\app.py %*
