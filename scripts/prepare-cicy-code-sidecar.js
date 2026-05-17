#!/usr/bin/env node
// Populates vendor/cicy-code/<platform>-<arch>/cicy-code so electron-builder
// can include the cicy-code daemon as an extraResources sidecar.
//
// Source resolution (first hit wins):
//   1. CICY_CODE_BIN_PATH  — single binary file, copied to the current host's
//      platform/arch slot only. Dev shortcut on the maintainer's own box.
//   2. CICY_CODE_DIST_DIR  — directory containing all four
//      cicy-code-{darwin,linux}-{amd64,arm64} files as produced by
//      `bash build.sh all` in the cicy-code repo. Used by CI.
//   3. ../cicy-code/dist   — sibling checkout fallback.
//
// Output layout (the ${arch} macro in electron-builder uses x64/arm64 naming,
// not Go's amd64/arm64, so we rename at copy time):
//   vendor/cicy-code/darwin-x64/cicy-code
//   vendor/cicy-code/darwin-arm64/cicy-code
//   vendor/cicy-code/linux-x64/cicy-code
//   vendor/cicy-code/linux-arm64/cicy-code
//
// On macOS hosts the copied binary is ad-hoc signed (`codesign --sign -`) so
// it loads on Apple Silicon (which refuses to exec any unsigned mach-o).
// When a real Apple Developer ID is configured, electron-builder's signing
// pass during build:mac will overwrite this ad-hoc sig.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor", "cicy-code");

const TARGETS = [
  { platform: "darwin", goArch: "amd64", electronArch: "x64" },
  { platform: "darwin", goArch: "arm64", electronArch: "arm64" },
  { platform: "linux",  goArch: "amd64", electronArch: "x64" },
  { platform: "linux",  goArch: "arm64", electronArch: "arm64" },
];

function nodePlatformToGo(p) {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return null;
}
function nodeArchToGo(a) {
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  return null;
}

function adhocSignIfDarwin(destPath, target) {
  if (process.platform !== "darwin" || target.platform !== "darwin") return;
  const r = spawnSync("codesign", ["--force", "--sign", "-", destPath], { stdio: "pipe", encoding: "utf8" });
  if (r.status === 0) {
    console.log(`[cicy-code-sidecar]   ad-hoc signed ${path.basename(destPath)}`);
  } else {
    console.warn(`[cicy-code-sidecar]   codesign failed (rc=${r.status}); arm64 may refuse to launch this binary: ${r.stderr.trim()}`);
  }
}

function copyOne(srcPath, target) {
  if (!fs.existsSync(srcPath)) return false;
  const destDir = path.join(VENDOR_ROOT, `${target.platform}-${target.electronArch}`);
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, "cicy-code");
  fs.copyFileSync(srcPath, destPath);
  fs.chmodSync(destPath, 0o755);
  const sizeMB = (fs.statSync(destPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[cicy-code-sidecar] ${target.platform}/${target.electronArch}  ${sizeMB} MB  <- ${srcPath}`);
  adhocSignIfDarwin(destPath, target);
  return true;
}

function main() {
  fs.mkdirSync(VENDOR_ROOT, { recursive: true });

  const binPath = process.env.CICY_CODE_BIN_PATH;
  if (binPath) {
    const goPlat = nodePlatformToGo(process.platform);
    const goArch = nodeArchToGo(process.arch);
    if (!goPlat || !goArch) {
      console.error(`[cicy-code-sidecar] CICY_CODE_BIN_PATH set but current host ${process.platform}/${process.arch} is not a supported sidecar target`);
      process.exit(1);
    }
    const t = TARGETS.find(x => x.platform === goPlat && x.goArch === goArch);
    if (!copyOne(binPath, t)) {
      console.error(`[cicy-code-sidecar] CICY_CODE_BIN_PATH=${binPath} does not exist`);
      process.exit(1);
    }
    return;
  }

  const sibling = path.resolve(REPO_ROOT, "..", "cicy-code", "dist");
  const distDir = process.env.CICY_CODE_DIST_DIR
    || (fs.existsSync(sibling) ? sibling : null);
  if (!distDir) {
    console.error("[cicy-code-sidecar] no source found.");
    console.error("  Set one of:");
    console.error("    CICY_CODE_BIN_PATH=/path/to/cicy-code");
    console.error("    CICY_CODE_DIST_DIR=/path/to/cicy-code/dist");
    console.error("  …or check out cicy-code as a sibling at ../cicy-code and run `bash build.sh all` there.");
    process.exit(1);
  }

  let copied = 0;
  for (const t of TARGETS) {
    const srcPath = path.join(distDir, `cicy-code-${t.platform}-${t.goArch}`);
    if (copyOne(srcPath, t)) copied++;
  }
  if (copied === 0) {
    console.error(`[cicy-code-sidecar] no expected binaries found under ${distDir}`);
    console.error("  Expected: cicy-code-{darwin,linux}-{amd64,arm64}");
    process.exit(1);
  }
}

main();
