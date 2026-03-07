const { execSync } = require("child_process");

describe("curl-rpc tool tests", () => {
  const curlRpc = (toolName, args = "") => {
    const cmd = args ? `curl-rpc ${toolName} ${args}` : `curl-rpc ${toolName}`;
    return execSync(cmd, { encoding: "utf8" });
  };

  test("ping", () => {
    const result = curlRpc("ping");
    expect(result).toContain("Pong");
  });

  test("r-reset", () => {
    const result = curlRpc("r-reset");
    expect(result).toContain("Cleared");
    expect(result).toContain("cached modules");
  });

  test("get_windows", () => {
    const result = curlRpc("get_windows");
    expect(result).toMatch(/\[|\]/); // JSON array
  });

  test("open_window", () => {
    const result = curlRpc("open_window", "url=https://example.com");
    expect(result).toContain("window");
  });

  test("get_window_info", () => {
    const result = curlRpc("get_window_info", "win_id=1");
    expect(result).toContain("id");
  });

  test("exec_js", () => {
    const result = curlRpc("exec_js", 'win_id=1 code="1+1"');
    expect(result).toContain("2");
  });

  test("clipboard_write_text", () => {
    const result = curlRpc("clipboard_write_text", 'text="test"');
    expect(result).toContain("clipboard");
  });

  test("clipboard_read_text", () => {
    curlRpc("clipboard_write_text", 'text="hello"');
    const result = curlRpc("clipboard_read_text");
    expect(result).toContain("hello");
  });
});
