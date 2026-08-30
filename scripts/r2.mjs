#!/usr/bin/env node
// scripts/r2.mjs — publish release assets to the Cloudflare R2 bucket.
//
// Replaces ossutil across the release workflows: one entry point that works
// the same from bash (linux/mac) and pwsh (windows), so the upload steps stop
// carrying three different CLIs.
//
//   node scripts/r2.mjs put <key> <file>     upload (overwrites)
//   node scripts/r2.mjs exists <key>         exit 0 if the object is there
//   node scripts/r2.mjs list <prefix>        print matching keys, one per line
//   node scripts/r2.mjs delete <key>         remove an object
//   node scripts/r2.mjs url <key>            print the public URL
//
// Credentials come from the environment, never from arguments (they would end
// up in the Actions log):
//   R2_ACCOUNT_ID, R2_API_TOKEN   required for put/list/delete
//   R2_BUCKET                     default: cicy-assets-poc
//   R2_PUBLIC_BASE                default: https://r2.deepfetch.de5.net
//
// put/delete shell out to wrangler (it handles multipart for the 100MB+
// installers). --remote is mandatory: since wrangler 4 the `r2 object`
// commands default to a LOCAL simulated store and silently write nothing.
// list has no wrangler equivalent, so it goes through the REST API.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";

const BUCKET = process.env.R2_BUCKET || "cicy-assets-poc";
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "https://r2.deepfetch.de5.net").replace(/\/$/, "");
const ACCOUNT = process.env.R2_ACCOUNT_ID || "";
const TOKEN = process.env.R2_API_TOKEN || "";
const WRANGLER = process.env.WRANGLER_VERSION || "wrangler@4";

const [cmd, ...rest] = process.argv.slice(2);

function die(msg, code = 1) {
  process.stderr.write(`r2: ${msg}\n`);
  process.exit(code);
}

function needCreds() {
  if (!ACCOUNT || !TOKEN) die("R2_ACCOUNT_ID and R2_API_TOKEN must be set");
}

// Windows: npx is npx.cmd, which Node only spawns with shell:true — and then
// cmd.exe re-parses the argv, so anything with a space ("CiCy Desktop Setup
// 2.1.324.exe") must be quoted or it arrives as several arguments.
export function shellQuote(arg, platform = process.platform) {
  const s = String(arg);
  if (platform !== "win32" || !/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function wrangler(args) {
  needCreds();
  const isWin = process.platform === "win32";
  const npx = isWin ? "npx.cmd" : "npx";
  const argv = ["--yes", WRANGLER, ...args, "--remote"].map((a) => shellQuote(a));
  const r = spawnSync(npx, argv, {
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
  });
  return r.status == null ? 1 : r.status;
}

async function api(path) {
  needCreds();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    die(`API ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") || "request failed"}`);
  }
  return body;
}

async function main() {
  switch (cmd) {
    case "put": {
      const [key, file] = rest;
      if (!key || !file) die("usage: r2.mjs put <key> <file>");
      if (!existsSync(file) || !statSync(file).isFile()) die(`file not found: ${file}`);
      const code = wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file]);
      if (code !== 0) process.exit(code);
      process.stdout.write(`${PUBLIC_BASE}/${key}\n`);
      break;
    }

    case "exists": {
      const [key] = rest;
      if (!key) die("usage: r2.mjs exists <key>");
      // The bucket is public, so a HEAD on the CDN answers without credentials
      // and without paging a listing.
      const res = await fetch(`${PUBLIC_BASE}/${key}`, { method: "HEAD" }).catch(() => null);
      process.exit(res && res.ok ? 0 : 1);
      break;
    }

    case "list": {
      const prefix = rest[0] || "";
      let cursor = "";
      const keys = [];
      do {
        const q = new URLSearchParams({ per_page: "1000" });
        if (prefix) q.set("prefix", prefix);
        if (cursor) q.set("cursor", cursor);
        const body = await api(`/r2/buckets/${BUCKET}/objects?${q}`);
        for (const o of body.result || []) keys.push(o.key);
        cursor = body.result_info?.cursor || "";
      } while (cursor);
      process.stdout.write(keys.join("\n") + (keys.length ? "\n" : ""));
      break;
    }

    case "delete": {
      const [key] = rest;
      if (!key) die("usage: r2.mjs delete <key>");
      process.exit(wrangler(["r2", "object", "delete", `${BUCKET}/${key}`]));
      break;
    }

    case "url": {
      const [key] = rest;
      if (!key) die("usage: r2.mjs url <key>");
      process.stdout.write(`${PUBLIC_BASE}/${key}\n`);
      break;
    }

    default:
      die(`unknown command "${cmd || ""}" — put | exists | list | delete | url`, 2);
  }
}

// Only run when executed directly (tests import shellQuote).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
