// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { z } = require("zod");
const fs = require("fs");
const path = require("path");

// desktop_snapshot — DEDICATED, NON-dangerous full-desktop screenshot tool for the
// cloud (cicy-code). It returns a base64 JPEG of the whole screen so cicy-code can
// preview a device's desktop WITHOUT going through exec_shell / file_read.
//
// Why a dedicated tool (+ w-10135):
//   exec_*/file_* are in rpc-guard's DANGEROUS_TOOLS, so each call pops the
//   "敏感操作请求" consent dialog, and on macOS the live `screencapture` shell also
//   trips the OS Screen-Recording prompt. This tool is NOT dangerous (deliberately
//   absent from DANGEROUS_TOOLS), and it reuses cicy-desktop's own native capturer
//   (which already holds the OS grant) — so: no shell, no consent dialog, no
//   per-call permission prompt.
//
// Source of the image (preferred → fallback):
//   1) ~/cicy-files/desktop-snapshot/desktop.b64 — written every few seconds by the
//      desktop-snapshot daemon (src/utils/desktop-snapshot.js, started in main.js).
//      On Windows this is the ONLY valid source (in-process desktopCapturer fails
//      over RDP without --disable-gpu; the daemon is a --disable-gpu child).
//   2) live in-process capture (mac/linux only) when the file is stale/missing.
const snap = require("../utils/desktop-snapshot");

// Treat the daemon file as good if written within this window. The daemon ticks
// every ~8s, so 30s tolerates a couple of missed/slow ticks before we live-capture.
const FRESH_MS = 30_000;

function readDaemonB64() {
  try {
    const p = path.join(snap.snapDir(), "desktop.b64");
    const st = fs.statSync(p);
    const ageMs = Date.now() - st.mtimeMs;
    const b64 = fs.readFileSync(p, "utf8").trim();
    if (b64.length > 256) return { b64, ageMs };
  } catch (_) {}
  return null;
}

module.exports = (registerTool) => {
  registerTool(
    "desktop_snapshot",
    "返回整屏桌面截图（base64 JPEG，≤600px 宽）。优先读 desktop-snapshot daemon 写的 desktop.b64（秒回、不弹 consent / 屏幕录制），过期或缺失时 mac/linux 即时抓屏。",
    z.object({ maxWidth: z.number().optional().describe("最大宽度(px)，默认 600") }),
    async ({ maxWidth }) => {
      try {
        const fresh = readDaemonB64();
        if (fresh && fresh.ageMs <= FRESH_MS) {
          return { content: [{ type: "text", text: fresh.b64 }] };
        }

        // Stale/missing. mac/linux can capture live in-process; win32 cannot (needs
        // the --disable-gpu daemon), so there we fall back to whatever file exists.
        // BUT honor snapshotEnabled(): on macOS capture is off by default, and a live
        // `screencapture` here is exactly what pops the Screen-Recording prompt (just
        // less often than the daemon did) — so when disabled we must NOT live-capture.
        // mac/linux:进程内即时抓屏(honor snapshotEnabled — mac 默认关避免授权弹窗)。
        if (process.platform !== "win32" && snap.snapshotEnabled()) {
          try {
            const r = await snap.captureB64(maxWidth);
            return { content: [{ type: "text", text: r.b64 }] };
          } catch (e) {
            if (fresh) return { content: [{ type: "text", text: fresh.b64 }] }; // stale but real
            throw e;
          }
        }
        // win32:进程内截不了(需 --disable-gpu)。按需起一个一次性 --disable-gpu 子进程
        // 截一张、写盘,再读回来 —— 这样没有常驻 daemon 也能手动截图(手动触发→写盘→拉图)。
        if (process.platform === "win32") {
          try {
            await snap.captureOnceWin();
            const after = readDaemonB64();
            if (after) return { content: [{ type: "text", text: after.b64 }] };
          } catch (e) {
            if (fresh) return { content: [{ type: "text", text: fresh.b64 }] };
            throw e;
          }
        }

        if (fresh) return { content: [{ type: "text", text: fresh.b64 }] }; // stale is better than nothing
        // macOS 默认关(避免反复弹屏幕录制授权)。
        if (process.platform === "darwin" && !snap.snapshotEnabled()) {
          throw new Error("桌面截图在 macOS 默认关闭(避免反复弹屏幕录制授权)。需要 agent 看屏幕时,启动 app 前设环境变量 CICY_DESKTOP_SNAPSHOT=1。");
        }
        throw new Error("no desktop snapshot yet");
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Desktop" }
  );
};
