// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Stamp platform onto <html> so CSS can reserve a left gutter for macOS
// hiddenInset traffic-light buttons (~78 px). data-fullscreen is toggled
// from main via window:fullscreen IPC — when fullscreen, traffic lights
// hide so the gutter goes away.
const platform = window.cicy?.platform || (() => {
  const ua = navigator.userAgent || "";
  return /Mac/i.test(ua) ? "darwin" : /Windows/i.test(ua) ? "win32" : "linux";
})();
document.documentElement.dataset.platform = platform;
document.documentElement.dataset.fullscreen = "0";
if (window.cicy?.window?.onFullscreen) {
  window.cicy.window.onFullscreen((isFs) => {
    document.documentElement.dataset.fullscreen = isFs ? "1" : "0";
  });
}

createRoot(document.getElementById("root")).render(<App />);
