const STALE_AFTER_MS = 15000;
const OFFLINE_AFTER_MS = 30000;

class WorkerRegistry {
  constructor() {
    this.workers = new Map();
  }

  upsert(worker) {
    const now = new Date().toISOString();
    const existing = this.workers.get(worker.workerId);
    const record = {
      ...existing,
      ...worker,
      workerId: worker.workerId,
      updatedAt: now,
      registeredAt: existing?.registeredAt || now,
      lastHeartbeatAt: worker.lastHeartbeatAt || existing?.lastHeartbeatAt || now,
      status: worker.status || existing?.status || "online",
    };

    this.workers.set(worker.workerId, record);
    return record;
  }

  markHeartbeat(workerId, payload = {}) {
    const existing = this.workers.get(workerId);
    if (!existing) {
      return this.upsert({
        workerId,
        ...payload,
        status: "online",
        lastHeartbeatAt: new Date().toISOString(),
      });
    }

    return this.upsert({
      ...existing,
      ...payload,
      workerId,
      status: "online",
      lastHeartbeatAt: new Date().toISOString(),
    });
  }

  get(workerId) {
    const worker = this.workers.get(workerId) || null;
    if (!worker) return null;
    return {
      ...worker,
      healthStatus: this.getHealthStatus(worker),
    };
  }

  getHealthStatus(worker, now = Date.now()) {
    if (!worker?.lastHeartbeatAt) return "offline";
    const ageMs = now - new Date(worker.lastHeartbeatAt).getTime();
    if (ageMs >= OFFLINE_AFTER_MS) return "offline";
    if (ageMs >= STALE_AFTER_MS) return "stale";
    return "online";
  }

  list() {
    const now = Date.now();
    return Array.from(this.workers.values())
      .map((worker) => ({
        ...worker,
        healthStatus: this.getHealthStatus(worker, now),
      }))
      .sort((a, b) => a.workerId.localeCompare(b.workerId));
  }
}

module.exports = { WorkerRegistry, STALE_AFTER_MS, OFFLINE_AFTER_MS };
