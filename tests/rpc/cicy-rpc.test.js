const { execSync } = require("child_process");

describe("cicy-rpc tool tests", () => {
  const cicyRpc = (toolName, args = "") => {
    const cmd = args ? `cicy-rpc ${toolName} ${args}` : `cicy-rpc ${toolName}`;
    return execSync(cmd, { encoding: "utf8" });
  };

  test("ping", () => {
    const result = cicyRpc("ping");
    expect(result).toContain("Pong");
  });

  test("r-reset", () => {
    const result = cicyRpc("r-reset");
    expect(result).toContain("Cleared");
    expect(result).toContain("cached modules");
  });

  test("get_windows", () => {
    const result = cicyRpc("get_windows");
    expect(result).toMatch(/\[|\]/); // JSON array
  });

  test("open_window", () => {
    const result = cicyRpc("open_window", "url=https://example.com");
    expect(result).toContain("window");
  });

  test("get_window_info", () => {
    const result = cicyRpc("get_window_info", "win_id=1");
    expect(result).toContain("id");
  });

  test("exec_js", () => {
    const result = cicyRpc("exec_js", 'win_id=1 code="1+1"');
    expect(result).toContain("2");
  });

  test("clipboard_write_text", () => {
    const result = cicyRpc("clipboard_write_text", 'text="test"');
    expect(result).toContain("clipboard");
  });

  test("clipboard_read_text", () => {
    cicyRpc("clipboard_write_text", 'text="hello"');
    const result = cicyRpc("clipboard_read_text");
    expect(result).toContain("hello");
  });
});
