@echo off
REM ---------------------------------------------------------------------------
REM Development launcher (hot reload).
REM
REM Why this file exists: some Electron-based host apps export
REM ELECTRON_RUN_AS_NODE=1 into the global environment. When that variable is
REM set, electron.exe starts as a plain Node interpreter instead of a GUI app,
REM so no window ever appears (and `require('electron').app` is undefined).
REM Clearing it here makes double-clicking this file always work.
REM ---------------------------------------------------------------------------

set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

echo Starting TodoList in development mode (hot reload)...
echo Close the app window to stop.
echo.

call npm run dev
