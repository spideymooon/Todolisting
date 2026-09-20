@echo off
REM ---------------------------------------------------------------------------
REM Run the already-built app (no hot reload, faster startup than dev.cmd).
REM Builds first if out\ is missing. Uses the same ELECTRON_RUN_AS_NODE guard
REM as dev.cmd - see that file for why.
REM ---------------------------------------------------------------------------

set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

if not exist "out\main\index.js" (
  echo Build output not found, building first...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Build failed. Aborting.
    pause
    exit /b 1
  )
)

echo Starting TodoList...
call "node_modules\.bin\electron.cmd" .
