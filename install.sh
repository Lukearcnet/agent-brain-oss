#!/bin/bash
# Agent Brain Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Lukearcnet/agent-brain-oss/main/install.sh | bash
#
# This script:
# 1. Checks for Node.js 18+ (installs via nvm if missing)
# 2. Clones the Agent Brain repository
# 3. Installs dependencies
# 4. Runs the interactive setup wizard

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Agent Brain Installer              ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check for Node.js ─────────────────────────────────────────────

check_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
      echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"
      return 0
    else
      echo -e "${YELLOW}⚠${NC} Node.js $(node -v) found, but v18+ required"
      return 1
    fi
  else
    echo -e "${YELLOW}⚠${NC} Node.js not found"
    return 1
  fi
}

install_node() {
  echo ""
  echo "Node.js 18+ is required. How would you like to install it?"
  echo ""
  echo "  1) Use Homebrew (recommended for macOS)"
  echo "  2) Use nvm (Node Version Manager)"
  echo "  3) I'll install it myself"
  echo ""
  read -p "  Choice (1/2/3): " choice

  case $choice in
    1)
      if command -v brew &>/dev/null; then
        echo "Installing Node.js via Homebrew..."
        brew install node
      else
        echo -e "${RED}Homebrew not found.${NC} Install it from https://brew.sh then re-run this script."
        exit 1
      fi
      ;;
    2)
      if command -v nvm &>/dev/null; then
        echo "Installing Node.js 20 via nvm..."
        nvm install 20
        nvm use 20
      else
        echo "Installing nvm first..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install 20
        nvm use 20
      fi
      ;;
    3)
      echo ""
      echo "Install Node.js 18+ from https://nodejs.org and re-run this script."
      exit 0
      ;;
    *)
      echo "Invalid choice. Exiting."
      exit 1
      ;;
  esac
}

if ! check_node; then
  install_node
  # Verify after install
  if ! check_node; then
    echo -e "${RED}Node.js installation failed. Please install Node.js 18+ manually.${NC}"
    exit 1
  fi
fi

# ── Step 2: Check for git ─────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  echo -e "${RED}git is required but not found.${NC}"
  echo "Install git: https://git-scm.com/downloads"
  exit 1
fi
echo -e "${GREEN}✓${NC} git detected"

# ── Step 3: Choose install directory ──────────────────────────────────────

DEFAULT_DIR="$HOME/agent-brain"
echo ""
read -p "Install directory [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "${YELLOW}⚠${NC} Directory $INSTALL_DIR already exists."
  read -p "  Use existing directory? (Y/n): " use_existing
  if [ "$use_existing" = "n" ] || [ "$use_existing" = "N" ]; then
    echo "Choose a different directory and re-run."
    exit 0
  fi
  cd "$INSTALL_DIR"
  # If it's a git repo, try pulling latest
  if [ -d ".git" ]; then
    echo "  Pulling latest changes..."
    git pull 2>/dev/null || echo "  (could not pull, continuing with existing)"
  fi
else
  echo ""
  echo "Cloning Agent Brain..."
  git clone https://github.com/Lukearcnet/agent-brain-oss.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

echo -e "${GREEN}✓${NC} Repository ready at $INSTALL_DIR"

# ── Step 4: Install dependencies ──────────────────────────────────────────

echo ""
echo "Installing dependencies..."
npm install --omit=dev 2>&1 | tail -3
echo -e "${GREEN}✓${NC} Dependencies installed"

# ── Step 5: Run setup wizard ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}Starting Agent Brain setup wizard...${NC}"
echo ""

if [ -f "bin/ab-setup" ]; then
  bash bin/ab-setup
else
  echo -e "${YELLOW}⚠${NC} Setup wizard not found. Run manually:"
  echo "  cd $INSTALL_DIR"
  echo "  cp .env.example .env"
  echo "  # Edit .env with your Supabase credentials"
  echo "  npm start"
fi
