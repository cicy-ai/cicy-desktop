const os = require("os");
const { config } = require("../config");

let workerIdentity = null;

function getWorkerIdentity() {
  if (!workerIdentity) {
    const hostname = os.hostname() || "localhost";
    const pid = process.pid;
    const port = config.port || process.env.PORT || "unknown";
    workerIdentity = {
      workerId: process.env.CICY_WORKER_ID || `${hostname}-${port}-${pid}`,
      hostname,
      pid,
      port,
      startedAt: new Date().toISOString(),
    };
  }

  return workerIdentity;
}

module.exports = {
  getWorkerIdentity,
};
