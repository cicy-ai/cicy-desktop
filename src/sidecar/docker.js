// Windows sidecar backend: run cicy-code inside a Docker container.
//
// Platform split (2026-06): mac/linux start cicy-code locally via `npx
// cicy-code` (see cicy-code.js); Windows runs it in Docker Desktop instead.
// The base-env image's entrypoint installs cicy-code from npm at container
// startup, so the image is version-independent. If the image isn't present
// locally it's loaded from R2 (CN-friendly, no Docker Hub pull):
//   https://r2.deepfetch.de5.net/docker/cicy-code-latest.tar.gz
//
// The container maps :8008 and persists ~/cicy-ai in a named volume.
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IMAGE     = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
const R2_TARBALL = process.env.CICY_DOCKER_URL  || "https://r2.deepfetch.de5.net/docker/cicy-code-latest.tar.gz";
const CONTAINER = process.env.CICY_DOCKER_CONTAINER || "cicy-code";
const VOLUME    = process.env.CICY_DOCKER_VOLUME || "cicy-ai-data";
// CICY_* env vars forwarded into the container (team onboarding, version pin…).
const PASS_ENV = ["CICY_TEAM_TOKEN", "CICY_CODE_VERSION", "NPM_REGISTRY", "CICY_NPM_REGISTRY", "CICY_AGENTS", "ENABLE_CDN", "CICY_CLOUDFLARED_TOKEN"];

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function dockerOk() {
  try { await run(["version", "--format", "{{.Server.Version}}"], { timeout: 8000 }); return true; }
  catch { return false; }
}

async function imagePresent() {
  try { await run(["image", "inspect", IMAGE], { timeout: 8000 }); return true; }
  catch { return false; }
}

function download(url, dest, hops = 5) {
  return new Promise((resolve, reject) => {
    if (hops <= 0) return reject(new Error("too many redirects"));
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, hops - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function loadImage() {
  const tmp = path.join(os.tmpdir(), `cicy-code-image-${process.pid}.tar.gz`);
  console.log(`[docker-sidecar] downloading image from ${R2_TARBALL}`);
  await download(R2_TARBALL, tmp);
  console.log(`[docker-sidecar] docker load…`);
  await run(["load", "-i", tmp], { timeout: 300000 });
  try { fs.unlinkSync(tmp); } catch {}
}

async function checkStatus() {
  const installed = await dockerOk();
  return { installed, imagePresent: installed ? await imagePresent() : false };
}

// Start the container. Returns a sidecar child token { docker:true, container,
// id } or null when Docker isn't ready (homepage guides the user to install
// Docker Desktop).
async function start({ port = 8008 } = {}) {
  if (!(await dockerOk())) {
    console.warn("[docker-sidecar] Docker not available — homepage will guide install");
    return null;
  }
  if (!(await imagePresent())) {
    try { await loadImage(); }
    catch (e) { console.warn(`[docker-sidecar] image load failed: ${e.message}`); return null; }
  }
  // Replace any stale container of the same name.
  try { await run(["rm", "-f", CONTAINER]); } catch {}

  const args = [
    "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
    "-p", `${port}:8008`,
    "-v", `${VOLUME}:/home/cicy/cicy-ai`,
  ];
  for (const k of PASS_ENV) {
    if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  }
  args.push(IMAGE);

  const { stdout } = await run(args, { timeout: 60000 });
  const id = stdout.trim().slice(0, 12);
  console.log(`[docker-sidecar] started container ${CONTAINER} (${id}) on :${port}`);
  return { docker: true, container: CONTAINER, id };
}

async function stop() {
  try { await run(["rm", "-f", CONTAINER]); } catch {}
}

module.exports = { start, stop, checkStatus, loadImage, imagePresent, dockerOk };
