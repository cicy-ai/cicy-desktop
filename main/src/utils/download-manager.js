// 全局下载管理器
const downloads = new Map();
let downloadIdCounter = 0;

function addDownload(downloadInfo) {
  const id = ++downloadIdCounter;
  downloads.set(id, {
    id,
    ...downloadInfo,
    createdAt: new Date().toISOString(),
  });
  return id;
}

function updateDownload(id, updates) {
  const download = downloads.get(id);
  if (download) {
    Object.assign(download, updates, { updatedAt: new Date().toISOString() });
  }
}

function getDownload(id) {
  return downloads.get(id);
}

function getAllDownloads() {
  return Array.from(downloads.values());
}

function clearDownloads() {
  downloads.clear();
  downloadIdCounter = 0;
}

module.exports = {
  addDownload,
  updateDownload,
  getDownload,
  getAllDownloads,
  clearDownloads,
};
