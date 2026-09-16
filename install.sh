#!/usr/bin/env bash
# Official installer for RCJA Soccer Sim
# Usage: curl -fsSL https://raw.githubusercontent.com/marc-cr1810/rcja-soccer-sim/main/install.sh | bash

set -euo pipefail

REPO="marc-cr1810/rcja-soccer-sim"
BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
RED='\033[31m'
RESET='\033[0m'

echo -e "\n${BOLD}RCJA Soccer Sim Installer${RESET}"
echo -e "=================================================="

# 1. Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)
    PLATFORM="linux"
    ;;
  darwin)
    PLATFORM="darwin"
    ;;
  *)
    echo -e "${RED}Error:${RESET} Unsupported operating system '$OS'. Linux and macOS are supported." >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)
    TARGET_ARCH="x64"
    ;;
  aarch64|arm64)
    TARGET_ARCH="arm64"
    ;;
  *)
    echo -e "${RED}Error:${RESET} Unsupported architecture '$ARCH'. x86_64 and arm64 are supported." >&2
    exit 1
    ;;
esac

ASSET_NAME="rcja-soccer-sim-${PLATFORM}-${TARGET_ARCH}"
echo -e "Target: ${CYAN}${PLATFORM}-${TARGET_ARCH}${RESET} (${ASSET_NAME})"

# 2. Check System Prerequisites
MISSING_PKGS=()
if ! command -v python3 >/dev/null 2>&1; then
  MISSING_PKGS+=("python3")
fi

if [ "$PLATFORM" = "linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  MISSING_PKGS+=("bubblewrap")
fi

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  echo -e "\n${YELLOW}Warning: Recommended dependencies missing:${RESET} ${MISSING_PKGS[*]}"
  if [ "$PLATFORM" = "linux" ]; then
    echo -e "  Install with: ${CYAN}sudo apt install -y ${MISSING_PKGS[*]}${RESET}"
  fi
fi

# 3. Choose Install Directory
if [ "${UID:-$(id -u)}" -eq 0 ]; then
  INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
else
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
fi
mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/rcja-soccer-sim"

# 4. Resolve Version and Download URL
VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
  VERSION_TEXT="latest"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
  VERSION_TEXT="$VERSION"
fi

echo -e "Downloading ${CYAN}${VERSION_TEXT}${RESET} binary from GitHub..."
TMP_DEST="${DEST}.download-$$"
if command -v curl >/dev/null 2>&1; then
  curl -fSL --progress-bar -o "$TMP_DEST" "$DOWNLOAD_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$TMP_DEST" "$DOWNLOAD_URL"
else
  echo -e "${RED}Error:${RESET} curl or wget is required to download rcja-soccer-sim." >&2
  exit 1
fi

chmod +x "$TMP_DEST"
mv -f "$TMP_DEST" "$DEST"

INSTALLED_VER="$("$DEST" --version 2>/dev/null || echo "installed")"
echo -e "\n${GREEN}✓ Successfully installed:${RESET} ${INSTALLED_VER}"
echo -e "Location: ${CYAN}${DEST}${RESET}"

# 5. Check PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo -e "\n${YELLOW}Note:${RESET} ${INSTALL_DIR} is not currently in your \$PATH."
    echo -e "Add it by running:"
    echo -e "  ${CYAN}echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc${RESET}"
    ;;
esac

# 6. Linux Service Lingering Check
if [ "$PLATFORM" = "linux" ] && command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || true
fi

# 7. Next Steps
echo -e "\n${BOLD}Next steps:${RESET}"
echo -e "  1. Initialize your league:"
echo -e "     ${CYAN}rcja-soccer-sim league-setup${RESET}"
echo -e ""
echo -e "  2. Register teams and get push keys:"
echo -e "     ${CYAN}rcja-soccer-sim team create \"Team Name\"${RESET}"
echo -e ""
echo -e "  3. Run in foreground or install as a systemd background service:"
echo -e "     ${CYAN}rcja-soccer-sim league${RESET}           # Run in terminal"
echo -e "     ${CYAN}rcja-soccer-sim service install${RESET}  # Run as systemd background service"
echo -e ""
