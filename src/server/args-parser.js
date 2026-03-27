function parseArgs() {
  const args = process.argv.slice(2);

  let PORT = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
  if (!PORT) {
    const portIndex = args.indexOf("--port");
    if (portIndex !== -1 && args[portIndex + 1]) {
      PORT = args[portIndex + 1];
    }
  }
  if (!PORT) {
    PORT = process.env.PORT;
  }
  PORT = parseInt(PORT) || 8101;

  let START_URL = args
    .find((arg) => arg.startsWith("--url="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!START_URL) {
    const urlIndex = args.indexOf("--url");
    if (urlIndex !== -1 && args[urlIndex + 1]) {
      START_URL = args[urlIndex + 1];
    }
  }

  let PROXY = args.find((arg) => arg.startsWith("--proxy="))?.split("=")[1];
  if (!PROXY) {
    const proxyIndex = args.indexOf("--proxy");
    if (proxyIndex !== -1 && args[proxyIndex + 1]) {
      PROXY = args[proxyIndex + 1];
    }
  }

  const oneWindow = args.includes("--one-window");

  let ACCOUNT = args.find((arg) => arg.startsWith("--account="))?.split("=")[1];
  if (!ACCOUNT) {
    const accountIndex = args.indexOf("--account");
    if (accountIndex !== -1 && args[accountIndex + 1]) {
      ACCOUNT = args[accountIndex + 1];
    }
  }
  ACCOUNT = parseInt(ACCOUNT) || 0;

  let chromeBinary = args.find((arg) => arg.startsWith("--chrome-binary="))?.split("=").slice(1).join("=");
  if (!chromeBinary) {
    const chromeBinaryIndex = args.indexOf("--chrome-binary");
    if (chromeBinaryIndex !== -1 && args[chromeBinaryIndex + 1]) {
      chromeBinary = args[chromeBinaryIndex + 1];
    }
  }

  let chromeUserDataRoot = args
    .find((arg) => arg.startsWith("--chrome-user-data-root="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!chromeUserDataRoot) {
    const chromeUserDataRootIndex = args.indexOf("--chrome-user-data-root");
    if (chromeUserDataRootIndex !== -1 && args[chromeUserDataRootIndex + 1]) {
      chromeUserDataRoot = args[chromeUserDataRootIndex + 1];
    }
  }

  let chromeDebuggerBasePort = args
    .find((arg) => arg.startsWith("--chrome-debugger-base-port="))
    ?.split("=")[1];
  if (!chromeDebuggerBasePort) {
    const chromeDebuggerBasePortIndex = args.indexOf("--chrome-debugger-base-port");
    if (chromeDebuggerBasePortIndex !== -1 && args[chromeDebuggerBasePortIndex + 1]) {
      chromeDebuggerBasePort = args[chromeDebuggerBasePortIndex + 1];
    }
  }
  chromeDebuggerBasePort = chromeDebuggerBasePort ? parseInt(chromeDebuggerBasePort, 10) : null;

  return {
    PORT,
    START_URL,
    PROXY,
    oneWindow,
    ACCOUNT,
    chromeBinary,
    chromeUserDataRoot,
    chromeDebuggerBasePort,
  };
}

module.exports = { parseArgs };
