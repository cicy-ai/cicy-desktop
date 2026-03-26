const DEFAULT_INTERVAL_MS = 5000;

class WorkerClient {
  constructor({
    masterUrl,
    workerToken,
    workerIdentity,
    getStatusSnapshot,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchImpl = fetch,
  }) {
    this.masterUrl = masterUrl;
    this.workerToken = workerToken;
    this.workerIdentity = workerIdentity;
    this.getStatusSnapshot = getStatusSnapshot;
    this.intervalMs = intervalMs;
    this.fetch = fetchImpl;
    this.timer = null;
  }

  get headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.workerToken}`,
    };
  }

  async post(path, payload) {
    const response = await this.fetch(new URL(path, this.masterUrl), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Master request failed with status ${response.status}`);
    }

    return data;
  }

  async register() {
    return this.post("/api/workers/register", {
      worker: this.workerIdentity,
      snapshot: this.getStatusSnapshot(),
    });
  }

  async heartbeat() {
    return this.post("/api/workers/heartbeat", {
      workerId: this.workerIdentity.workerId,
      snapshot: this.getStatusSnapshot(),
    });
  }

  async start() {
    await this.register();
    this.timer = setInterval(() => {
      this.heartbeat().catch((error) => {
        console.error(`[WorkerClient] heartbeat failed: ${error.message}`);
      });
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { WorkerClient };
