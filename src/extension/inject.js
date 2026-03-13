console.log("hi cicy v4");

window.__cicyInjected = true;
window.__cicyTime = new Date().toISOString();

// 创建全局工具对象
window._g = window._g || {};

// ========================================
// Electron RPC Bridge - control everything
// ========================================
try {
  const { ipcRenderer } = require('electron');
  window.electronRPC = (tool, args) => ipcRenderer.invoke('rpc', tool, args || {});
  window._g.rpc = window.electronRPC;
  console.log('[RPC] electronRPC ready');
} catch(e) {
  console.log('[RPC] not in electron:', e.message);
}

// ========================================
// 剪贴板权限支持
// ========================================

// 确保剪贴板 API 可用
if (navigator.clipboard) {
  console.log("[Clipboard] Clipboard API is available");
  
  // 测试剪贴板权限
  navigator.permissions.query({ name: 'clipboard-read' }).then(result => {
    console.log(`[Clipboard] Read permission: ${result.state}`);
  }).catch(e => {
    console.log("[Clipboard] Read permission query failed:", e.message);
  });
  
  navigator.permissions.query({ name: 'clipboard-write' }).then(result => {
    console.log(`[Clipboard] Write permission: ${result.state}`);
  }).catch(e => {
    console.log("[Clipboard] Write permission query failed:", e.message);
  });
} else {
  console.log("[Clipboard] Clipboard API is not available");
}

// 添加剪贴板工具函数
window._g.clipboard = {
  // 读取剪贴板文本
  readText: async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      console.error("[Clipboard] Read text failed:", e);
      throw e;
    }
  },
  
  // 写入剪贴板文本
  writeText: async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      console.log("[Clipboard] Text written successfully");
    } catch (e) {
      console.error("[Clipboard] Write text failed:", e);
      throw e;
    }
  },
  
  // 读取剪贴板（包括图片）
  read: async () => {
    try {
      return await navigator.clipboard.read();
    } catch (e) {
      console.error("[Clipboard] Read failed:", e);
      throw e;
    }
  },
  
  // 写入剪贴板（包括图片）
  write: async (data) => {
    try {
      await navigator.clipboard.write(data);
      console.log("[Clipboard] Data written successfully");
    } catch (e) {
      console.error("[Clipboard] Write failed:", e);
      throw e;
    }
  }
};

// ========================================
// IndexedDB 基础工具
// ========================================

window._g.getIndexedDBRows = async (dbName, storeName, limit = 100) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const results = [];
  return new Promise((resolve) => {
    const request = store.openCursor();
    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
  });
};

window._g.listIndexedDB = async () => {
  const dbs = await indexedDB.databases();
  const result = {};
  for (const dbInfo of dbs) {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbInfo.name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        setTimeout(() => reject(new Error("timeout")), 1000);
      });
      result[dbInfo.name] = Array.from(db.objectStoreNames);
      db.close();
    } catch (e) {
      result[dbInfo.name] = "error: " + e.message;
    }
  }
  return result;
};
