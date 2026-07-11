// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Release-time obfuscation of the MAIN-PROCESS source (src/**/*.js), run as part
// of the prebuild hooks. Electron ships JS as plaintext inside app.asar (anyone can
// `asar extract` and read it), so on release we obfuscate our authored source.
//
// Gated by CICY_OBFUSCATE=1 — set ONLY in the release workflows. Local/dev builds
// (Loop B on Mac, plain `npm run build:*`) leave the working tree untouched, so this
// never dirties source you're editing. CI runs on a disposable checkout.
//
// The renderer (src/backends/homepage-react) is EXCLUDED here: it's already
// Vite-minified (identifiers mangled, comments stripped) and additionally obfuscated
// by vite-plugin-javascript-obfuscator during its own build. Re-obfuscating the
// bundled React output post-hoc is high-risk / low-reward, so we don't.

const fs = require("fs");
const path = require("path");

if (process.env.CICY_OBFUSCATE !== "1") {
  console.log("[obfuscate] CICY_OBFUSCATE != 1 — skipping (dev build, source untouched).");
  process.exit(0);
}

const JavaScriptObfuscator = require("javascript-obfuscator");
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const EXCLUDE_DIRS = [
  path.join(SRC, "backends", "homepage-react"), // Vite-built SPA snapshot (obfuscated by the Vite plugin)
];

// 保守配置:重命名标识符 + 字符串数组(base64)+ compact。**故意关掉** controlFlowFlattening /
// deadCodeInjection / selfDefending / debugProtection —— 这几项最容易把代码搞坏、且严重拖慢启动。
// 目标是"读不懂",不是"跑不动"。renameGlobals=false:绝不动 require/module/exports/process 等全局名。
const OPTIONS = {
  compact: true,
  simplify: true,
  target: "node",
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  splitStrings: false,
  numbersToExpressions: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
};

function isExcluded(p) {
  return EXCLUDE_DIRS.some((d) => p === d || p.startsWith(d + path.sep));
}
function* walkJs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (isExcluded(full)) continue;
    if (e.isDirectory()) yield* walkJs(full);
    else if (e.isFile() && full.endsWith(".js")) yield full;
  }
}

let count = 0;
let outBytes = 0;
for (const file of walkJs(SRC)) {
  const code = fs.readFileSync(file, "utf8");
  try {
    const out = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode();
    fs.writeFileSync(file, out);
    count++;
    outBytes += out.length;
  } catch (e) {
    // Fail the build rather than ship a half-obfuscated app.
    console.error(`[obfuscate] FAILED ${path.relative(ROOT, file)}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`[obfuscate] obfuscated ${count} main-process file(s), ${Math.round(outBytes / 1024)}KB total (renderer handled by the Vite plugin).`);
