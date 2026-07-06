// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" so the built bundle's relative asset URLs resolve under
// file:// when cicy-desktop loads src/backends/homepage-react/index.html.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "0.0.0.0", port: 8173 },
});
