#!/bin/bash
# CiCy Desktop — offline all-in-one installer for macOS (NO Apple signing needed).
#
# Without an Apple Developer cert a DOWNLOADED .app/.dmg is Gatekeeper-quarantined
# ("已损坏 / 无法打开", hard-blocked on arm64). electron-builder already produces a
# working ad-hoc-signed CiCy Desktop.app (in the -mac.zip); the only thing stopping
# it from opening is the download quarantine flag. So this installer:
#   1. installs that prebuilt .app and strips the quarantine (xattr -cr) + re-ad-hoc-
#      signs it locally (codesign --sign -, no cert) → opens normally, no signing.
#   2. pre-stages the docker base disk + cicy-code image so the app's docker
#      bootstrap REUSES them → zero download, fully offline.
#
# Bundle layout (this file sits at the bundle root):
#   CiCy Desktop.app                          — prebuilt app (from electron-builder)
#   docker/ubuntu-2404-<arch>-docker.raw.gz   — colima base disk (340MB)
#   docker/cicy-code-latest.tar.gz            — cicy-code image (167MB)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="CiCy Desktop"
DEST_APP="/Applications/$APP_NAME.app"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && DTAG="amd64" || DTAG="arm64"

echo "==> CiCy Desktop 离线安装(arch=$ARCH)"

SRC_APP="$HERE/$APP_NAME.app"
[ -d "$SRC_APP" ] || { echo "缺少 $APP_NAME.app(包损坏?)"; exit 1; }

# ── 1) 安装到 /Applications ─────────────────────────────────────────────────
echo "==> 安装到 $DEST_APP …"
if [ -w "/Applications" ] || [ ! -e "$DEST_APP" ]; then
  rm -rf "$DEST_APP" 2>/dev/null || true
  ditto "$SRC_APP" "$DEST_APP"
else
  echo "    需要管理员权限覆盖旧版,请输入密码:"
  sudo rm -rf "$DEST_APP"; sudo ditto "$SRC_APP" "$DEST_APP"
  sudo chown -R "$(id -un)":staff "$DEST_APP" 2>/dev/null || true
fi

# ── 2) 清隔离 + 本地 ad-hoc 自签(免 Apple 证书的关键)──────────────────────
echo "==> 清隔离属性 + 本地 ad-hoc 自签 …"
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
xattr -cr "$DEST_APP" 2>/dev/null || true
# 重新 ad-hoc 签整个 bundle(ditto 后保险起见;已签则等价覆盖)
codesign --force --deep --sign - "$DEST_APP" 2>/dev/null || \
  echo "    (codesign 警告可忽略,quarantine 已清即可打开)"

# ── 3) 预暂存 docker 包(让 app 的 bootstrap reuse、零下载)──────────────────
echo "==> 预暂存 docker 运行环境(基础盘 + 镜像)…"
mkdir -p "$HOME/cicy-ai/colima" "$HOME/Downloads"
DISK_SRC="$HERE/docker/ubuntu-2404-$DTAG-docker.raw.gz"
IMG_SRC="$HERE/docker/cicy-code-latest.tar.gz"
[ -f "$DISK_SRC" ] && ditto "$DISK_SRC" "$HOME/cicy-ai/colima/ubuntu-2404-$DTAG-docker.raw.gz" && echo "    基础盘已就位($DTAG)"
[ -f "$IMG_SRC" ]  && ditto "$IMG_SRC"  "$HOME/Downloads/cicy-code-latest.tar.gz" && echo "    cicy-code 镜像已就位"

echo ""
echo "✅ 安装完成 —— 打开「启动台」或 /Applications 里的「$APP_NAME」。"
echo "   docker 运行环境已预置,首次点安装直接复用、不下载。"
open "$DEST_APP" || true
