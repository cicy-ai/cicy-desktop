async function loadPanelCellUrl(webContents, url) {
  let isTelegram = false;
  try { isTelegram = new URL(url).hostname === "web.telegram.org"; } catch (e) {}
  if (isTelegram && webContents.debugger) {
    try {
      await webContents.loadURL("about:blank");
      if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
      await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
    } catch (e) {}
  }
  const result = await webContents.loadURL(url);
  if (isTelegram && typeof webContents.insertCSS === "function") {
    await webContents.insertCSS(
      "html, body { width: 100% !important; height: 100% !important; overflow: hidden !important; } body { clip-path: inset(0 round 19px); contain: paint; }",
    );
  }
  return result;
}

module.exports = { loadPanelCellUrl };
