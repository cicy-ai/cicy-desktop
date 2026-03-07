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

  let START_URL = args.find((arg) => arg.startsWith("--url="))?.split("=")[1];
  if (!START_URL) {
    const urlIndex = args.indexOf("--url");
    if (urlIndex !== -1 && args[urlIndex + 1]) {
      START_URL = args[urlIndex + 1];
    }
  }

  const oneWindow = args.includes("--one-window");

  return { PORT, START_URL, oneWindow };
}

module.exports = { parseArgs };
