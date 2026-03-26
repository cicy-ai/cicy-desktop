const fs = require("fs");
const path = require("path");
const { getWorkerIdentity } = require("./worker-identity");
const { createArtifactId } = require("./types");

const artifacts = new Map();

function normalizeArtifactKind(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".json", ".txt", ".log", ".html", ".js", ".css"].includes(ext)) return "document";
  return "file";
}

function registerArtifact(filePath, metadata = {}) {
  if (!filePath || typeof filePath !== "string") return null;

  const { workerId } = getWorkerIdentity();
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const kind = metadata.kind || normalizeArtifactKind(filePath);
  const artifactId = createArtifactId(workerId, kind, Buffer.from(filePath).toString("base64url"));
  const record = {
    artifactId,
    workerId,
    kind,
    filePath,
    size: stat ? stat.size : metadata.size || null,
    exists: !!stat,
    createdAt: metadata.createdAt || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    metadata,
  };

  artifacts.set(artifactId, record);
  return record;
}

function maybeRegisterArtifact(value, metadata = {}) {
  if (!value || typeof value !== "object") return value;

  if (typeof value.__file === "string") {
    const record = registerArtifact(value.__file, {
      ...metadata,
      size: value.__size,
      binary: value.__binary,
      error: value.__error,
    });
    return record ? { ...value, artifact: record } : value;
  }

  return value;
}

function listArtifacts() {
  return Array.from(artifacts.values()).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

module.exports = {
  registerArtifact,
  maybeRegisterArtifact,
  listArtifacts,
};
