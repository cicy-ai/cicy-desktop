// Docker 容器保护开关(默认开启)。
//
// 目标:cicy-code 容器一旦跑起来,**任何自动流程**都不得销毁/重建它,也不得
// `wsl --shutdown` / 注销 distro 把它连带干掉。只允许:
//   • `docker start` 已存在的容器(开机自启、掉线拉起);
//   • 容器**不存在**时 `docker run` 新建。
// 用户在 UI 明确点击的破坏性操作(重建/换端口/DooD/升级)需带 `force:true` 才放行。
//
// 开关持久化在 ~/cicy-ai/db/docker-protect.json({ enabled: bool });
// 环境变量 CICY_DOCKER_PROTECT=0 可临时关闭(调试用)。纯文件/环境读写,不依赖 electron,
// 便于单测。
const fs = require("fs");
const path = require("path");
const os = require("os");

const FLAG_FILE = path.join(os.homedir(), "cicy-ai", "db", "docker-protect.json");

function readFlag(file = FLAG_FILE) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.enabled === "boolean") return j.enabled;
  } catch {}
  return null;
}

function isProtected({ env = process.env, file = FLAG_FILE } = {}) {
  const v = String(env.CICY_DOCKER_PROTECT ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  const f = readFlag(file);
  return f === null ? true : f; // 默认开启
}

function setProtected(enabled, { file = FLAG_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled: !!enabled, ts: new Date().toISOString() }));
  return !!enabled;
}

// 统一判定:某个破坏性动作现在能不能做。返回 { allowed, reason }。
//   action  — 动作名(日志用)
//   force   — 用户显式操作(UI 已 confirm)传 true;自动流程不传
function decide(action, { force = false, opts } = {}) {
  if (force) return { allowed: true, reason: "force" };
  if (!isProtected(opts)) return { allowed: true, reason: "protect-off" };
  return { allowed: false, reason: `docker-protect: 已拦截自动执行的 ${action}` };
}

// 便捷:被拦截时写 warn 日志并返回 false。
function guard(log, action, arg = {}) {
  const d = decide(action, arg);
  if (!d.allowed && log) log.warn(`[docker-protect] ${d.reason}`);
  return d.allowed;
}

module.exports = { FLAG_FILE, isProtected, setProtected, decide, guard };
