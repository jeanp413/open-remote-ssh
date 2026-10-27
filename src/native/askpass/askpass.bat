@echo off
setlocal

:createTempFile
set "NATIVE_SSH_ASKPASS_FILE=%TEMP%\native-ssh-askpass-%RANDOM%.tmp"
if exist "%NATIVE_SSH_ASKPASS_FILE%" goto createTempFile

"%NATIVE_SSH_NODE_BIN%" "%NATIVE_SSH_ASKPASS_NODE_SCRIPT%" %*
set "ASKPASS_STATUS=%ERRORLEVEL%"

if exist "%NATIVE_SSH_ASKPASS_FILE%" (
  if "%ASKPASS_STATUS%"=="0" type "%NATIVE_SSH_ASKPASS_FILE%"
  del /f /q "%NATIVE_SSH_ASKPASS_FILE%"
)

exit /b %ASKPASS_STATUS%
