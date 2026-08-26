function createDockerAuditRecord(channel, event, args = {}) {
  return {
    ts: new Date().toISOString(),
    channel,
    webContentsId: event?.sender?.id ?? null,
    senderUrl: event?.senderFrame?.url || event?.sender?.getURL?.() || "",
    args,
  };
}

function auditDestructiveIpc(log, channel, event, args = {}) {
  const record = createDockerAuditRecord(channel, event, args);
  log.warn(`[docker-audit] ${JSON.stringify(record)}`);
  return record;
}

module.exports = { createDockerAuditRecord, auditDestructiveIpc };
