@echo off
rem p01-ballistic-viewer: build the trace engine. Demo bots are compiled on demand by the server.
setlocal
cd /d %~dp0..

echo [1/1] trace engine
g++ -O2 -std=c++17 -static server\trace_engine\engine_trace.cpp -o server\trace_engine\engine_trace.exe
if errorlevel 1 goto :err

echo BUILD OK
exit /b 0
:err
echo BUILD FAILED
exit /b 1
