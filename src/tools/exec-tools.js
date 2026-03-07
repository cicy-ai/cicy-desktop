const { z } = require("zod");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const fs = require("fs");
const path = require("path");
const os = require("os");

const TMP = path.join(os.homedir(), "tmp");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function writeTemp(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function resolveFile(file, content, ext) {
  if (content) return writeTemp(`_exec_${Date.now()}${ext}`, content);
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error("File not found: " + resolved);
  return resolved;
}

function result(stdout, stderr) {
  return { content: [{ type: "text", text: JSON.stringify({ stdout: stdout || "", stderr: stderr || "", exitCode: 0 }, null, 2) }] };
}
function errorResult(error) {
  return { content: [{ type: "text", text: JSON.stringify({ stdout: error.stdout || "", stderr: error.stderr || error.message, exitCode: error.code || 1 }, null, 2) }], isError: true };
}

function registerTools(registerTool) {
  registerTool(
    "exec_shell",
    "Execute shell command",
    z.object({
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ command, cwd }) => {
      try {
        const { stdout, stderr } = await execPromise(command, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );

  registerTool(
    "exec_python",
    "Execute Python code",
    z.object({
      code: z.string().describe("Python code to execute"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ code, cwd }) => {
      try {
        const py = process.platform === "win32" ? "python" : "python3";
        const { stdout, stderr } = await execPromise(`${py} -c ${JSON.stringify(code)}`, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );

  registerTool(
    "exec_node",
    "Execute Node.js code",
    z.object({
      code: z.string().describe("Node.js code to execute"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ code, cwd }) => {
      try {
        const { stdout, stderr } = await execPromise(`node -e ${JSON.stringify(code)}`, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );

  registerTool(
    "exec_shell_file",
    "Execute shell script. Provide file path or content (content will be saved to temp file and executed).",
    z.object({
      file: z.string().optional().describe("Path to shell script file"),
      content: z.string().optional().describe("Shell script content (uploaded and executed)"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ file, content, cwd }) => {
      try {
        const resolved = resolveFile(file, content, ".bat");
        const cmd = process.platform === "win32" ? `"${resolved}"` : `bash "${resolved}"`;
        const { stdout, stderr } = await execPromise(cmd, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );

  registerTool(
    "exec_python_file",
    "Execute Python script. Provide file path or content (content will be saved to temp file and executed).",
    z.object({
      file: z.string().optional().describe("Path to Python script file"),
      content: z.string().optional().describe("Python script content (uploaded and executed)"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ file, content, cwd }) => {
      try {
        const resolved = resolveFile(file, content, ".py");
        const py = process.platform === "win32" ? "python" : "python3";
        const { stdout, stderr } = await execPromise(`${py} "${resolved}"`, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );

  registerTool(
    "exec_node_file",
    "Execute Node.js script. Provide file path or content (content will be saved to temp file and executed).",
    z.object({
      file: z.string().optional().describe("Path to Node.js script file"),
      content: z.string().optional().describe("Node.js script content (uploaded and executed)"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    async ({ file, content, cwd }) => {
      try {
        const resolved = resolveFile(file, content, ".js");
        const { stdout, stderr } = await execPromise(`node "${resolved}"`, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
        return result(stdout, stderr);
      } catch (e) { return errorResult(e); }
    },
    { tag: "Exec" }
  );
}

module.exports = registerTools;
