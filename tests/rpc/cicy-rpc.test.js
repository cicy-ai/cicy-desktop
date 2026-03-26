const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const { getPort } = require("../mcp/setup-test-server");

describe("cicy-rpc CLI", () => {
  const repoRoot = path.join(__dirname, "../..");
  const rpcBin = path.join(repoRoot, "bin", "cicy-rpc");
  const desktopBin = path.join(repoRoot, "bin", "cicy-desktop");
  const globalJsonPath = path.join(os.homedir(), "global.json");

  beforeAll(() => {
    const port = getPort();
    let config = {};

    if (fs.existsSync(globalJsonPath)) {
      config = JSON.parse(fs.readFileSync(globalJsonPath, "utf8"));
    }

    config.cicyDesktopNodes = {
      ...(config.cicyDesktopNodes || {}),
      windows: {
        api_token: config.api_token || "",
        base_url: `http://localhost:${port}`,
      },
    };

    fs.writeFileSync(globalJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  });

  const runCli = (binPath, args = [], env = {}) =>
    execFileSync("node", [binPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  test("ping", () => {
    const result = runCli(rpcBin, ["ping"], { CICY_NODE: "windows" });
    expect(result).toContain("Pong");
  });

  test("tools", () => {
    const result = runCli(rpcBin, ["tools"], { CICY_NODE: "windows" });
    expect(result).toContain("open_window");
  });

  test("tools <name>", () => {
    const result = runCli(rpcBin, ["tools", "open_window"], { CICY_NODE: "windows" });
    expect(result).toContain("open_window - ");
    expect(result).toContain("url");
  });

  test("open_window", () => {
    const result = runCli(rpcBin, ["open_window", "url=https://example.com"], {
      CICY_NODE: "windows",
    });
    expect(result).toContain("window");
  });

  test("json output", () => {
    const result = runCli(rpcBin, ["--json", "get_windows"], { CICY_NODE: "windows" });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("cicy-desktop rejects rpc commands", () => {
    try {
      runCli(desktopBin, ["open_window", "url=https://example.com"], { CICY_NODE: "windows" });
      throw new Error("Expected cicy-desktop to fail for RPC command");
    } catch (error) {
      const stderr = (error && error.stderr ? error.stderr.toString() : "") || "";
      const stdout = (error && error.stdout ? error.stdout.toString() : "") || "";
      expect(`${stdout}\n${stderr}`).toMatch(/Unknown command: open_window/);
    }
  });

  test("shell compatibility wrapper forwards to new cli", () => {
    const wrapperPath = path.join(repoRoot, "skills", "cicy-rpc", "cicy-rpc");
    const result = execSync(`bash "${wrapperPath}" ping`, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CICY_NODE: "windows" },
    });
    expect(result).toContain("Pong");
  });
});
