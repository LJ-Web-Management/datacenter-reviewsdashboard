@echo off
rem Runs the dashboard and restarts it if it ever exits. Output goes to data\server.log
cd /d "%~dp0..\.."
if not exist data mkdir data
:loop
echo [%date% %time%] starting server >> data\server.log
node src\node.js >> data\server.log 2>&1
echo [%date% %time%] server exited with code %errorlevel%, restarting in 10 seconds >> data\server.log
rem "timeout" does not work without a console window, so ping is used as a 10 second sleep
ping -n 11 127.0.0.1 >nul
goto loop
