// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import obfuscator from "vite-plugin-javascript-obfuscator";

// base: "./" so the built bundle's relative asset URLs resolve under
// file:// when cicy-desktop loads src/backends/homepage-react/index.html.
//
// 发版时(CICY_OBFUSCATE=1,只在 release CI 设)对**构建产物**再做一层混淆 —— Vite 本身已经
// minify(变量已改名),这层进一步打乱字符串等。保守配置(不开 controlFlowFlattening /
// deadCodeInjection / selfDefending)以免搞坏 React 运行时。dev 与本地普通 build 不启用、零影响。
const OBFUSCATE = process.env.CICY_OBFUSCATE === "1";

// The inline deployment watchdog in index.html needs the build stamp; a plugin
// substitutes it so the marker never ships unreplaced.
const stampPlugin = () => ({
  name: "cicy-build-stamp",
  transformIndexHtml(html) {
    return html.replaceAll("__BUILD_STAMP__", process.env.CICY_BUILD_STAMP || "dev");
  },
});

export default defineConfig({
  // Build stamp: the page compares it with what the server reports to notice a
  // newer deployment and reload itself.
  define: { __BUILD_STAMP__: JSON.stringify(process.env.CICY_BUILD_STAMP || "dev") },
  plugins: [
    stampPlugin(),
    react(),
    ...(OBFUSCATE
      ? [obfuscator({
          include: ["**/*.js"],
          exclude: [/node_modules/],
          apply: "build",
          options: {
            compact: true,
            simplify: true,
            identifierNamesGenerator: "hexadecimal",
            renameGlobals: false,
            stringArray: true,
            stringArrayThreshold: 0.75,
            stringArrayEncoding: ["base64"],
            controlFlowFlattening: false,
            deadCodeInjection: false,
            selfDefending: false,
            debugProtection: false,
            disableConsoleOutput: false,
          },
        })]
      : []),
  ],
  base: "./",
  server: { host: "0.0.0.0", port: 8173 },
});
