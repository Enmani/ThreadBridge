@echo off
pushd "%~dp0"
node src\cli.mjs %*
set "threadbridge_exit=%errorlevel%"
popd
exit /b %threadbridge_exit%
