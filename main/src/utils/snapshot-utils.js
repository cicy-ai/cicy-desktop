// snapshot-utils.js
// Snapshot utilities for Electron MCP server
// Provides page snapshot capture with screenshots and element references
const { clipboard, nativeImage } = require("electron");

async function captureSnapshot(webContents, options = {}) {
  const { win_id = 1 } = options;

  const image = await webContents.capturePage();
  let size = image.getSize(); // 逻辑尺寸

  // 检测是否为 macOS
  if (process.platform === "darwin") {
    // 将图片缩小到逻辑尺寸（即原始物理像素的一半）
    // resize 会返回一个新的 NativeImage 对象
    const resizedImage = image.resize({
      width: size.width,
      height: size.height,
      quality: "better", // 可选: 'good', 'better', 'best'
    });

    // 更新数据
    var finalImage = resizedImage;
  } else {
    var finalImage = image;
  }
  const pngBuffer = finalImage.toPNG();
  // 2. 使用 Buffer 重新创建 NativeImage (确保数据完整)
  const imageToPaste = nativeImage.createFromBuffer(pngBuffer);

  // 3. 写入剪贴板
  clipboard.writeImage(imageToPaste);

  const screenshotData = finalImage.toPNG().toString("base64");
  return {
    content: [
      {
        type: "text",
        text: `Size: ${size.width}x${size.height} (macOS auto-scaled)`,
      },
      {
        type: "text",
        text: `Image has write to clipboard`,
      },
      {
        type: "image",
        data: screenshotData,
        mimeType: "image/png",
      },
    ],
  };
}

module.exports = {
  captureSnapshot,
};
