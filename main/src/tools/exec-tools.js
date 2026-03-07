const { z } = require("zod");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

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
        const { stdout, stderr } = await execPromise(command, {
          cwd: cwd || process.cwd(),
          maxBuffer: 1024 * 1024 * 10,
        });

        const result = {
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: 0,
        };

        if (!stdout && !stderr) {
          result.message = "Command executed successfully but returned no output";
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const result = {
          stdout: error.stdout || "",
          stderr: error.stderr || error.message || "Unknown error",
          exitCode: error.code || 1,
          error: error.message,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
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
        const { stdout, stderr } = await execPromise(`python3 -c ${JSON.stringify(code)}`, {
          cwd: cwd || process.cwd(),
          maxBuffer: 1024 * 1024 * 10,
        });

        const result = {
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: 0,
        };

        if (!stdout && !stderr) {
          result.message = "Python code executed successfully but returned no output";
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const result = {
          stdout: error.stdout || "",
          stderr: error.stderr || error.message || "Python execution failed",
          exitCode: error.code || 1,
          error: error.message,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
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
        const { stdout, stderr } = await execPromise(`node -e '${code.replace(/'/g, "'\\''")}'`, {
          cwd: cwd || process.cwd(),
          maxBuffer: 1024 * 1024 * 10,
        });

        const result = {
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: 0,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const result = {
          stdout: error.stdout || "",
          stderr: error.stderr || error.message || "Node.js execution failed",
          exitCode: error.code || 1,
          error: error.message,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }
    },
    { tag: "Exec" }
  );
}

module.exports = registerTools;
