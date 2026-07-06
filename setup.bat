@echo off
chcp 65001 >nul 2>nul
REM ================================================================
REM  ovolv999 一键安装 (Windows)
REM
REM  用法: 双击运行 或 在终端执行 setup.bat
REM  安装后: 终端输入 ovolv999 即可启动
REM ================================================================

echo.
echo  =======================================
echo    ovolv999 Agent Base — Setup (Windows)
echo  =======================================
echo.

REM ── 1. 检查 Node.js ──
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [X] Node.js not found
    echo      Install from https://nodejs.org (LTS recommended)
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  [OK] Node.js: %NODE_VER%

REM ── 2. 切到项目目录 ──
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
cd /d "%PROJECT_DIR%"

REM ── 3. 检测包管理器 ──
set PKG=pnpm
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    set PKG=npm
    echo  [!] pnpm not found, using npm
    echo      For faster installs: npm install -g pnpm
) else (
    for /f "tokens=*" %%i in ('pnpm -v') do set PM_VER=%%i
    echo  [OK] pnpm: %PM_VER%
)

REM ── 4. 安装依赖 ──
echo.
echo  [1/4] Installing dependencies...
if exist "node_modules" (
    echo  [SKIP] node_modules exists
) else (
    call %PKG% install
    if %errorlevel% neq 0 (
        echo  [X] Install failed
        pause
        exit /b 1
    )
)
echo  [OK] Dependencies ready

REM ── 5. 编译 ──
echo.
echo  [2/4] Building TypeScript...
if exist "dist\bin\ovogogogo.js" (
    echo  [SKIP] dist/ exists ^(delete to rebuild^)
) else (
    call %PKG% run build
    if %errorlevel% neq 0 (
        echo  [X] Build failed
        pause
        exit /b 1
    )
)
echo  [OK] Build complete

REM ── 6. API Key 配置 ──
echo.
echo  [3/4] API Key configuration...
if exist ".env" (
    echo  [SKIP] .env already exists
) else (
    if defined OPENAI_API_KEY (
        echo  OPENAI_API_KEY=%OPENAI_API_KEY%> .env
        echo  [OK] Wrote .env from current environment
    ) else (
        echo.
        echo  API Key is required to run ovolv999.
        echo  Paste your OpenAI-compatible API key ^(or press Enter to skip^):
        set /p API_KEY="  Key: "
        if not "%API_KEY%"=="" (
            echo  OPENAI_API_KEY=%API_KEY%> .env
            echo  [OK] Saved to .env
        ) else (
            echo  [!] Skipped — set OPENAI_API_KEY env var or create .env manually
        )
    )
)

REM ── 7. 全局命令 ──
echo.
echo  [4/4] Creating global command "ovolv999"...
call %PKG% link 2>nul
if %errorlevel% neq 0 (
    echo  [!] npm link failed, creating wrapper manually...
    for /f "tokens=*" %%i in ('npm prefix -g') do set "GPREFIX=%%i"
    (
        echo @echo off
        echo node "%PROJECT_DIR%\dist\bin\ovogogogo.js" %%*
    ) > "%GPREFIX%\ovolv999.cmd"
    echo  [OK] Created %GPREFIX%\ovolv999.cmd
) else (
    echo  [OK] Global command "ovolv999" linked
)

REM ── 8. 验证 ──
echo.
echo  =======================================
echo    Verification
echo  =======================================
echo.
ovolv999 --version 2>nul
if %errorlevel% neq 0 (
    echo  [!] Command not in PATH yet
    echo      Restart your terminal, or run: node dist\bin\ovogogogo.js
) else (
    echo  [OK] ovolv999 is ready!
)

echo.
echo  =======================================
echo    Done!
echo  =======================================
echo.
echo  Usage:
echo    ovolv999                         Interactive REPL
echo    ovolv999 "fix type errors"        Single task
echo    ovolv999 --help                   Show help
echo.
echo  Config (.env or environment vars):
echo    OPENAI_API_KEY=sk-...             Required
echo    OPENAI_BASE_URL=https://...       Optional (proxy)
echo    OVOGO_MODEL=claude-sonnet-4-6     Optional (model name)
echo.
pause
