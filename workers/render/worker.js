// desktop.cicy-ai.com — static homepage + the fleet control channel.
//
// WHY THIS IS THE PRIMARY CHANNEL
//
// Reaching a desktop used to mean going through something else that the desktop
// had to have registered with: a local cicy-code (agent-desktop) or the hub
// (hub-desktop). Both are conditional. A desktop that is running perfectly but
// registered nowhere is invisible to both, and you cannot ask it why without
// already being able to reach it.
//
// This channel has no such precondition. Every desktop loads its homepage from
// this Worker, so it can always dial back to the same origin it was served
// from. No hub login, no cicy-code, no address, no inbound port, no token on
// the device. The socket is open exactly while the app is running, so presence
// is a fact rather than an inference.
//
// Levels, cheapest first:
//   any request        → [hit], works whatever JS the page is running
//   POST /api/report   → what the page knows about itself
//   WS  /ws            → live presence AND bidirectional RPC   ← use this
//
// Control surface (operator side, requires CTRL_TOKEN):
//   GET  /api/fleet                      → who is connected right now
//   POST /api/rpc {target,tool,args,js}  → run it there, get the answer back
const UA_VER = /CiCyDesktop\/([0-9.]+)/;
function ident(request) {
  const ua = request.headers.get("user-agent") || "";
  const m = ua.match(UA_VER);
  return {
    isDesktop: !!m,
    version: m ? m[1] : "",
    plat: /Windows/.test(ua) ? "win" : /Mac OS/.test(ua) ? "mac" : /Linux/.test(ua) ? "linux" : "?",
    ip: request.headers.get("cf-connecting-ip") || "?",
  };
}

// The deployed build id, served by the SERVER rather than kept in a static file
// the page has to remember to publish. index.html is rewritten on the way out so
// the shell always carries the id of the deployment that served it, and
// /api/version reports the same value — a page can therefore always tell whether
// it is stale, with nothing to keep in sync by hand.
const BUILD = "20260903071217"; // replaced at deploy time, monotonic

const json = (o, status) =>
  new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Fail closed: with no CTRL_TOKEN configured nothing can drive the fleet.
function authed(request, env) {
  const want = env.CTRL_TOKEN;
  if (!want) return false;
  const got =
    request.headers.get("x-cicy-ctrl") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!got && got === want;
}

const fleet = (env) => env.FLEET.get(env.FLEET.idFromName("fleet"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = ident(request);

    // Older bundles poll /version.json for `stamp`, newer ones /api/version for
    // `build`. Serving both from the same id is what lets a page from ANY past
    // deployment still notice it is stale — freezing one when the source moved
    // is exactly how a machine gets stranded on a dead bundle.
    if (url.pathname === "/version.json") return json({ stamp: BUILD, build: BUILD });
    if (url.pathname === "/api/version") return json({ build: BUILD });

    // Desktop dials in here. No auth: the socket only ever grants the *caller*
    // the ability to be commanded, never to command.
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
      const u = new URL(request.url);
      u.pathname = "/connect";
      u.searchParams.set("v", id.version || "");
      u.searchParams.set("plat", id.plat);
      u.searchParams.set("ip", id.ip);
      return fleet(env).fetch(new Request(u, request));
    }

    if (url.pathname === "/api/fleet") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const u = new URL(request.url);
      u.pathname = "/list";
      return fleet(env).fetch(new Request(u, { method: "GET" }));
    }

    if (url.pathname === "/api/rpc" && request.method === "POST") {
      if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
      const u = new URL(request.url);
      u.pathname = "/rpc";
      return fleet(env).fetch(
        new Request(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        })
      );
    }

    if (id.isDesktop) console.log(`[hit] v=${id.version} plat=${id.plat} ip=${id.ip} path=${url.pathname}`);

    if (url.pathname === "/api/result" && request.method === "POST") {
      try {
        const b = await request.json();
        console.log(`[result] ${b.host || "?"} id=${b.id} out=${String(b.out).slice(0, 800)}`);
      } catch {}
      return json({ ok: true });
    }
    if (url.pathname === "/api/report" && request.method === "POST") {
      try {
        const b = await request.json();
        console.log(`[fleet] ${b.host || "?"} v=${b.version} auto=${b.auto} kind=${b.kind || "?"}`);
      } catch {}
      return json({ ok: true });
    }

    const res = await env.ASSETS.fetch(request);
    // Stamp the shell and never let it be cached — a cached index.html pins a
    // machine to an old build no matter what is deployed.
    if ((res.headers.get("content-type") || "").includes("text/html")) {
      const body = (await res.text()).replace("__SERVER_BUILD__", BUILD);
      const h = new Headers(res.headers);
      h.set("cache-control", "no-store");
      h.set("x-cicy-build", BUILD);
      return new Response(body, { status: res.status, headers: h });
    }
    return res;
  },
};

// One instance holds every socket, so "who is up" is a lookup rather than a
// poll. Non-hibernating sockets keep this object resident for as long as any
// desktop is connected; if it is ever evicted the sockets close and the pages
// reconnect on their own backoff.
const RPC_TIMEOUT_MS = 45 * 1000;
const STALE_MS = 3 * 60 * 1000;

export class Fleet {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.peers = new Map(); // connId -> {ws, host, v, plat, ip, since, seen, auto}
    this.waiters = new Map(); // rid -> {resolve, timer}
    this.n = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect(request, url);
    if (url.pathname === "/list") return json({ build: BUILD, peers: this.list() });
    if (url.pathname === "/rpc") return this.rpc(request);
    return json({ error: "not found" }, 404);
  }

  list() {
    const now = Date.now();
    const out = [];
    for (const [cid, p] of this.peers) {
      if (now - p.seen > STALE_MS) { try { p.ws.close(1001, "stale"); } catch {} this.peers.delete(cid); continue; }
      out.push({ cid, host: p.host, v: p.v, plat: p.plat, ip: p.ip, auto: p.auto,
                 upSec: Math.round((now - p.since) / 1000), idleSec: Math.round((now - p.seen) / 1000) });
    }
    return out.sort((a, b) => String(a.host).localeCompare(String(b.host)));
  }

  connect(request, url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const cid = `c${++this.n}-${Date.now().toString(36)}`;
    const p = {
      ws: server,
      host: url.searchParams.get("host") || "?",
      v: url.searchParams.get("v") || "",
      plat: url.searchParams.get("plat") || "?",
      ip: url.searchParams.get("ip") || "?",
      auto: null,
      since: Date.now(),
      seen: Date.now(),
    };
    this.peers.set(cid, p);
    console.log(`[ws+] ${p.host} v=${p.v} ${p.plat} ${p.ip} cid=${cid} n=${this.peers.size}`);

    server.addEventListener("message", (e) => {
      p.seen = Date.now();
      let f = null;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      if (f.type === "hello") {
        // The page knows more about itself than the UA does.
        if (f.host) p.host = f.host;
        if (f.v) p.v = f.v;
        if (f.plat) p.plat = f.plat;
        if (typeof f.auto === "boolean") p.auto = f.auto;
        // One entry per machine: a reload leaves the old socket briefly open.
        for (const [other, q] of this.peers) {
          if (other !== cid && q.host === p.host) { try { q.ws.close(1000, "superseded"); } catch {} this.peers.delete(other); }
        }
        console.log(`[hello] ${p.host} v=${p.v} auto=${p.auto} cid=${cid}`);
        try { server.send(JSON.stringify({ type: "welcome", cid, build: BUILD })); } catch {}
        return;
      }
      if (f.type === "ping") { try { server.send(JSON.stringify({ type: "pong" })); } catch {} return; }
      if (f.type === "rpc_result") {
        const w = this.waiters.get(f.rid);
        if (w) { clearTimeout(w.timer); this.waiters.delete(f.rid); w.resolve({ host: p.host, ok: f.ok !== false, out: f.out }); }
        return;
      }
      if (f.type === "log") console.log(`[log] ${p.host} ${String(f.text).slice(0, 400)}`);
    });

    const drop = (why) => {
      if (this.peers.get(cid) === p) this.peers.delete(cid);
      console.log(`[ws-] ${p.host} cid=${cid} ${why} n=${this.peers.size}`);
    };
    server.addEventListener("close", (e) => drop(`closed:${e && e.code}`));
    server.addEventListener("error", () => drop("error"));

    return new Response(null, { status: 101, webSocket: client });
  }

  async rpc(request) {
    let b = {};
    try { b = await request.json(); } catch {}
    const target = String(b.target || "all");
    const timeout = Math.min(Math.max(Number(b.timeout) || RPC_TIMEOUT_MS, 2000), 120000);

    const picked = [];
    for (const [cid, p] of this.peers) {
      const hit = target === "all" || cid === target ||
                  String(p.host).toLowerCase() === target.toLowerCase() ||
                  String(p.host).toLowerCase().includes(target.toLowerCase());
      if (hit) picked.push([cid, p]);
    }
    if (!picked.length) return json({ error: "no matching peer", target, peers: this.list() }, 404);

    const calls = picked.map(([cid, p]) => new Promise((resolve) => {
      const rid = `r${++this.n}-${Date.now().toString(36)}`;
      const timer = setTimeout(() => { this.waiters.delete(rid); resolve({ host: p.host, ok: false, out: "timeout" }); }, timeout);
      this.waiters.set(rid, { resolve, timer });
      try {
        p.ws.send(JSON.stringify({ type: "rpc", rid, tool: b.tool, args: b.args, js: b.js }));
      } catch (e) {
        clearTimeout(timer); this.waiters.delete(rid);
        resolve({ host: p.host, ok: false, out: `send failed: ${(e && e.message) || e}` });
      }
    }));
    return json({ results: await Promise.all(calls) });
  }
}
