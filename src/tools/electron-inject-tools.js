// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");

const MAX_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*\.js$/;

function injectRoot() {
  return path.resolve(
    process.env.CICY_ELECTRON_INJECT_DIR ||
      path.join(os.homedir(), "cicy-ai", "electron", "extension", "inject")
  );
}

function targetPath(name) {
  if (!SAFE_NAME.test(name) || path.basename(name) !== name) {
    throw new Error("name must be a lowercase JavaScript basename");
  }
  const root = injectRoot();
  const target = path.join(root, name);
  if (path.dirname(target) !== root) throw new Error("inject target escapes the fixed root");
  return { root, target };
}

function rejectSymlink(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("inject target must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function describe(operation, name, target) {
  rejectSymlink(target);
  if (!fs.existsSync(target)) return { operation, name, path: target, exists: false, size: 0, sha256: null };
  const bytes = fs.readFileSync(target);
  return {
    operation,
    name,
    path: target,
    exists: true,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function install(name, content) {
  const { root, target } = targetPath(name);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_BYTES) throw new Error(`inject content exceeds ${MAX_BYTES} bytes`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  rejectSymlink(target);
  const temp = path.join(root, `.${name}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return describe("install", name, target);
}

function operate({ operation, name, content }) {
  const { target } = targetPath(name);
  if (operation === "install") return install(name, content);
  if (operation === "status") return describe(operation, name, target);
  rejectSymlink(target);
  const existed = fs.existsSync(target);
  if (existed) fs.unlinkSync(target);
  return { operation, name, path: target, existed, exists: false, size: 0, sha256: null };
}

function registerTools(registerTool) {
  registerTool(
    "electron_inject",
    "Install, inspect, or uninstall a JavaScript file under ~/cicy-ai/electron/extension/inject/",
    z.object({
      operation: z.enum(["install", "status", "uninstall"]),
      name: z.string(),
      content: z.string().optional(),
    }).superRefine((value, ctx) => {
      if (value.operation === "install" && typeof value.content !== "string") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "content is required for install" });
      }
    }),
    async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(operate(args), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Electron" }
  );
}

module.exports = registerTools;
module.exports.injectRoot = injectRoot;
module.exports.targetPath = targetPath;
module.exports.operate = operate;
