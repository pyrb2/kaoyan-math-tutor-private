@echo off
setlocal

set "APP_ROOT=%~dp0"
set "NODE_EXE=node"
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

where node >nul 2>nul
if errorlevel 1 (
  if exist "%BUNDLED_NODE%" (
    set "NODE_EXE=%BUNDLED_NODE%"
  ) else (
    echo [error] Node.js 24 or newer is required.
    echo Install Node.js, then run this file again.
    exit /b 1
  )
)

"%NODE_EXE%" -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(24)"
if errorlevel 1 (
  if exist "%BUNDLED_NODE%" (
    set "NODE_EXE=%BUNDLED_NODE%"
    "%BUNDLED_NODE%" -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(24)"
    if errorlevel 1 (
      echo [error] Node.js 24 or newer is required.
      exit /b 1
    )
  ) else (
    echo [error] Node.js 24 or newer is required.
    exit /b 1
  )
)

pushd "%APP_ROOT%"
"%NODE_EXE%" src\server.mjs
set "APP_EXIT_CODE=%ERRORLEVEL%"
popd

exit /b %APP_EXIT_CODE%
