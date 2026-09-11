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
    // 只锁尺寸、去掉页面自己的滚动条。原来这里还有
    //   body { clip-path: inset(0 round 19px); contain: paint; }
    // 把页面四角裁成圆的 —— 19px 是当年给手机预览那个 28px 圆角容器写的,
    // 网格格子的圆角是 14px,对不上,而且 Facebook 格子从来就是方角。已去掉。
    await webContents.insertCSS(
      "html, body { width: 100% !important; height: 100% !important; overflow: hidden !important; }",
    );
  }
  return result;
}

module.exports = { loadPanelCellUrl };
