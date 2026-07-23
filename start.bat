@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "TITLE=Qdrant Viewer Electron"

echo.
echo  [Qdrant Viewer] Starting Electron app...
echo.

if not exist "node_modules\" (
  echo  Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo  npm install failed.
    pause
    exit /b 1
  )
)

start "%TITLE%" /D "%~dp0" cmd /c "npm run dev"
exit /b 0
