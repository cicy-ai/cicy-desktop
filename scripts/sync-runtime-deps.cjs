#!/usr/bin/env node
// Sync optionalDependencies to the LATEST published per-platform cicy-code and
// cicy-mihomo subpackages, so every cicy-desktop build/publish bundles the
// newest binaries. Run in CI before install/build (and before `npm publish`).
//
// 主人指令 (2026-06-08): Windows no longer ships msys2/tmux — the win sidecar
// runs the single headless 团队助手 (--helper), so cicy-msys2-* is DROPPED here.
//
// Usage: node scripts/sync-runtime-deps.cjs   (writes package.json in place)

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmjs.org";
const PLATFORMS = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];
const COMPONENTS = ["cicy-code", "cicy-mihomo"]; // NOT cicy-msys2 — win drops it

function latest(pkg) {
  try {
    return execFileSync("npm", ["view", pkg, "version", `--registry=${REGISTRY}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null; // not published for this platform (e.g. cicy-code has no windows-arm64)
  }
}

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const resolved = {};
for (const comp of COMPONENTS) {
  for (const plat of PLATFORMS) {
    const name = `${comp}-${plat}`;
    const v = latest(name);
    if (v) resolved[name] = v;
  }
}
if (Object.keys(resolved).length === 0) {
  console.error("[sync-runtime-deps] resolved nothing — registry unreachable? aborting (package.json untouched)");
  process.exit(1);
}

// Keep any non-runtime optionalDeps; replace cicy-code-*/cicy-mihomo-*; drop cicy-msys2-*.
const kept = Object.fromEntries(
  Object.entries(pkg.optionalDependencies || {}).filter(
    ([k]) => !k.startsWith("cicy-code-") && !k.startsWith("cicy-mihomo-") && !k.startsWith("cicy-msys2")
  )
);
pkg.optionalDependencies = { ...kept, ...resolved };

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("[sync-runtime-deps] optionalDependencies ->");
for (const [k, v] of Object.entries(resolved)) console.log(`  ${k}@${v}`);
console.log("[sync-runtime-deps] dropped cicy-msys2-* (Windows no longer bundles msys2/tmux)");
