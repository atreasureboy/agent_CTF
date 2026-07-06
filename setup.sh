#!/bin/bash
# ================================================================
#  ovolv999 一键安装 (macOS / Linux)
#
#  用法: ./setup.sh
#  安装后: 终端输入 ovolv999 即可启动
# ================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "  ======================================="
echo "    ovolv999 Agent Base — Setup"
echo "  ======================================="
echo ""

# ── 1. Node.js ──
if ! command -v node &> /dev/null; then
    echo -e "${RED}[X] Node.js not found${NC}"
    echo "    Install: https://nodejs.org (LTS)"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Node.js: $(node -v)"

# ── 2. Project dir ──
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# ── 3. Package manager ──
PKG="npm"
if command -v pnpm &> /dev/null; then
    PKG="pnpm"
    echo -e "${GREEN}[OK]${NC} pnpm: $(pnpm -v)"
elif command -v yarn &> /dev/null; then
    PKG="yarn"
    echo -e "${GREEN}[OK]${NC} yarn: $(yarn -v)"
else
    echo -e "${GREEN}[OK]${NC} npm: $(npm -v)"
    echo -e "${YELLOW}[!]${NC} For faster installs: npm install -g pnpm"
fi

# ── 4. Install ──
echo ""
echo -e "${CYAN}[1/4]${NC} Installing dependencies..."
if [ -d "node_modules" ]; then
    echo -e "${YELLOW}[SKIP]${NC} node_modules exists"
else
    eval "$PKG install"
fi
echo -e "${GREEN}[OK]${NC} Dependencies ready"

# ── 5. Build ──
echo ""
echo -e "${CYAN}[2/4]${NC} Building TypeScript..."
if [ -f "dist/bin/ovogogogo.js" ]; then
    echo -e "${YELLOW}[SKIP]${NC} dist/ exists (rm -rf dist to rebuild)"
else
    eval "$PKG run build"
fi
echo -e "${GREEN}[OK]${NC} Build complete"

# ── 6. API Key ──
echo ""
echo -e "${CYAN}[3/4]${NC} API Key configuration..."
if [ -f ".env" ]; then
    echo -e "${YELLOW}[SKIP]${NC} .env already exists"
elif [ -n "$OPENAI_API_KEY" ]; then
    echo "OPENAI_API_KEY=$OPENAI_API_KEY" > .env
    echo -e "${GREEN}[OK]${NC} Wrote .env from current environment"
else
    echo ""
    echo "  API Key is required. Paste your key (or Enter to skip):"
    read -r -p "  Key: " API_KEY
    if [ -n "$API_KEY" ]; then
        echo "OPENAI_API_KEY=$API_KEY" > .env
        echo -e "${GREEN}[OK]${NC} Saved to .env"
    else
        echo -e "${YELLOW}[!]${NC} Skipped — set OPENAI_API_KEY or create .env manually"
    fi
fi

# ── 7. Global command ──
echo ""
echo -e "${CYAN}[4/4]${NC} Creating global command \"ovolv999\"..."
if [ "$PKG" = "pnpm" ]; then
    pnpm link --global 2>/dev/null && echo -e "${GREEN}[OK]${NC} Linked via pnpm" || {
        # Fallback: manual symlink
        GLOBAL_BIN="$(npm prefix -g)/bin"
        mkdir -p "$GLOBAL_BIN"
        ln -sf "$PROJECT_DIR/dist/bin/ovogogogo.js" "$GLOBAL_BIN/ovolv999"
        chmod +x "$GLOBAL_BIN/ovolv999"
        echo -e "${GREEN}[OK]${NC} Created $GLOBAL_BIN/ovolv999"
    }
elif [ "$PKG" = "yarn" ]; then
    yarn global add file:"$PROJECT_DIR" 2>/dev/null && echo -e "${GREEN}[OK]${NC} Linked via yarn" || {
        GLOBAL_BIN="$(npm prefix -g)/bin"
        mkdir -p "$GLOBAL_BIN"
        ln -sf "$PROJECT_DIR/dist/bin/ovogogogo.js" "$GLOBAL_BIN/ovolv999"
        chmod +x "$GLOBAL_BIN/ovolv999"
        echo -e "${GREEN}[OK]${NC} Created $GLOBAL_BIN/ovolv999"
    }
else
    npm link 2>/dev/null && echo -e "${GREEN}[OK]${NC} Linked via npm" || {
        GLOBAL_BIN="$(npm prefix -g)/bin"
        mkdir -p "$GLOBAL_BIN"
        ln -sf "$PROJECT_DIR/dist/bin/ovogogogo.js" "$GLOBAL_BIN/ovolv999"
        chmod +x "$GLOBAL_BIN/ovolv999"
        echo -e "${GREEN}[OK]${NC} Created $GLOBAL_BIN/ovolv999"
    }
fi

# ── 8. Verify ──
echo ""
echo "  ======================================="
echo "    Verification"
echo "  ======================================="
echo ""
if command -v ovolv999 &> /dev/null; then
    ovolv999 --version
    echo -e "${GREEN}[OK]${NC} ovolv999 is ready!"
else
    echo -e "${YELLOW}[!]${NC} Not in PATH yet — restart terminal or run:"
    echo "    node $PROJECT_DIR/dist/bin/ovogogogo.js"
fi

echo ""
echo "  ======================================="
echo "    Done!"
echo "  ======================================="
echo ""
echo -e "  Usage:"
echo -e "    ${CYAN}ovolv999${NC}                         Interactive REPL"
echo -e "    ${CYAN}ovolv999 \"fix type errors\"${NC}        Single task"
echo -e "    ${CYAN}ovolv999 --help${NC}                   Show help"
echo ""
echo -e "  Config (.env or environment vars):"
echo -e "    OPENAI_API_KEY=sk-...             Required"
echo -e "    OPENAI_BASE_URL=https://...       Optional (proxy)"
echo -e "    OVOGO_MODEL=claude-sonnet-4-6     Optional (model name)"
echo ""
