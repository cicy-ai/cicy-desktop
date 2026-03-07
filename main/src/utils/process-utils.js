const { exec } = require("child_process");
const net = require("net");
const { promisify } = require("util");

const execAsync = promisify(exec);

/**
 * 检查端口是否开放（被占用）
 * @param {number} port - 端口号
 * @param {string} [host='localhost'] - 主机地址
 * @param {number} [timeout=1000] - 超时时间（毫秒）
 * @returns {Promise<boolean>} true=端口开放/被占用, false=端口关闭/可用
 */
async function isPortOpen(port, host = "localhost", timeout = 1000) {
  // 验证端口范围
  if (typeof port !== "number" || port < 0 || port >= 65536) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    const onError = () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    };

    const onTimeout = () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    };

    const onConnect = () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(true);
      }
    };

    socket.setTimeout(timeout);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("connect", onConnect);

    socket.connect(port, host);
  });
}

/**
 * 杀死占用指定端口的进程
 * @param {number} port - 端口号
 * @returns {Promise<{success: boolean, message: string, pid?: number}>}
 */
async function killPort(port) {
  const platform = process.platform;

  try {
    if (platform === "win32") {
      return await killPortWindows(port);
    } else {
      return await killPortUnix(port);
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to kill process on port ${port}: ${error.message}`,
    };
  }
}

/**
 * Windows 平台杀死端口进程
 * @private
 */
async function killPortWindows(port) {
  try {
    // 查找占用端口的进程
    const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);

    if (!stdout.trim()) {
      return {
        success: false,
        message: `No process found on port ${port}`,
      };
    }

    // 提取 PID（最后一列）
    const lines = stdout.trim().split("\n");
    const pids = new Set();

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== "0") {
        pids.add(pid);
      }
    }

    if (pids.size === 0) {
      return {
        success: false,
        message: `No valid PID found for port ${port}`,
      };
    }

    // 杀死所有相关进程
    for (const pid of pids) {
      try {
        await execAsync(`taskkill /F /PID ${pid}`);
      } catch (err) {
        // 进程可能已经结束，忽略错误
      }
    }

    return {
      success: true,
      message: `Killed process(es) on port ${port}`,
      pid: parseInt(Array.from(pids)[0]),
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to kill process on port ${port}: ${error.message}`,
    };
  }
}

/**
 * Unix 平台（Linux/macOS）杀死端口进程
 * @private
 */
async function killPortUnix(port) {
  try {
    // 使用 fuser 查找占用端口的进程（不需要 root 权限）
    const { stdout } = await execAsync(`fuser ${port}/tcp 2>/dev/null || true`);

    if (!stdout.trim()) {
      return {
        success: false,
        message: `No process found on port ${port}`,
      };
    }

    // 提取 PID
    const pids = stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pid) => parseInt(pid));

    if (pids.length === 0) {
      return {
        success: false,
        message: `No valid PID found for port ${port}`,
      };
    }

    // 杀死进程
    await execAsync(`kill -9 ${pids.join(" ")}`);

    return {
      success: true,
      message: `Killed process(es) on port ${port}`,
      pid: pids[0],
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to kill process on port ${port}: ${error.message}`,
    };
  }
}

module.exports = {
  isPortOpen,
  killPort,
};
