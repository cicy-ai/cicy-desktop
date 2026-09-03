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
const BUILD = "20260903133941"; // replaced at deploy time, monotonic

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

    // Auto sign-in for a client that has none. The homepage calls this only
    // when it is NOT already logged in; the sponsor token stays here in the
    // Worker (never shipped to the page), and enrolment is owner-scoped, so all
    // it can ever do is add one of the owner's own machines under the owner's
    // account. Gated to real desktops by UA.
    if (url.pathname === "/api/auto-enroll" && request.method === "POST") {
      // Hand the owner's sponsor token to a real desktop so its MAIN process can
      // enrol directly with the hub. The Worker deliberately does NOT call the
      // hub itself: a Worker subrequest to the Cloudflare-proxied hub loops
      // ("too many redirects"), while the desktop's own https call succeeds.
      // UA-gated to desktops; the token only ever enrols the owner's own boxes.
      if (!id.isDesktop) return json({ error: "desktop only" }, 403);
      const sponsor = env.SPONSOR_TOKEN;
      if (!sponsor) return json({ error: "no sponsor configured" }, 503);
      return json({ sponsor });
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
// A peer is named by its declared team; the hostname is only a fallback
// label for one that has not been told what it is yet.
const label = (p) => (p && (p.team || p.host)) || "?";

const RPC_TIMEOUT_MS = 45 * 1000;
const HELLO_GRACE_MS = 20 * 1000;
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

  // One entry per machine, keyed on the DECLARED team first.
  //
  // The machine id looked like the stronger key and is not: these Windows boxes
  // were cloned from one image, so they carry an identical hubDesktopInstanceId
  // and keying on it made two different machines evict each other forever —
  // each one connecting knocked the other off, and neither stayed up long
  // enough to answer anything. The team is assigned per machine by the person
  // who owns it, so it is the only value here that is unique by construction.
  // The id and the hostname remain as fallbacks for a machine not yet named.
  evict(cid, p) {
    const key = (x) => (x.team ? "t:" + x.team : x.mid ? "m:" + x.mid : "h:" + x.host);
    const mine = key(p);
    for (const [other, q] of this.peers) {
      if (other === cid) continue;
      if (key(q) === mine) {
        console.log(`[ws~] superseded ${label(q)} cid=${other}`);
        try { q.ws.close(1000, "superseded"); } catch {}
        this.peers.delete(other);
      }
    }
  }

  // A client is controllable only if it proves it is the owner's: it presents
  // its hubAuth token, and the token is accepted by the hub's own directory.
  // Everyone may connect and appear in the roster; only the verified may be
  // driven. Cached so a reconnect is not a fresh round-trip.
  async verifyAuth(cid, p, tok) {
    const now = Date.now();
    this._authCache = this._authCache || new Map();
    const hit = this._authCache.get(tok);
    if (hit && hit.exp > now) { p.authed = hit.ok; return; }
    let ok = false;
    try {
      const r = await fetch("https://ws.cicy-ai.com/api/instances", { headers: { authorization: "Bearer " + tok } });
      ok = r.ok;
    } catch {}
    this._authCache.set(tok, { ok, exp: now + 5 * 60 * 1000 });
    if (this.peers.get(cid) === p) { p.authed = ok; console.log(`[auth] ${label(p)} ${ok ? "verified" : "REJECTED"}`); }
  }

  list() {
    const now = Date.now();
    const out = [];
    for (const [cid, p] of this.peers) {
      if (now - p.seen > STALE_MS) { try { p.ws.close(1001, "stale"); } catch {} this.peers.delete(cid); continue; }
      out.push({ cid, id: p.mid, short: p.short, authed: p.authed, team: p.team, host: p.host, v: p.v, plat: p.plat, ip: p.ip, auto: p.auto,
                 upSec: Math.round((now - p.since) / 1000), idleSec: Math.round((now - p.seen) / 1000) });
    }
    return out.sort((a, b) => String(a.team || a.host).localeCompare(String(b.team || b.host)));
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
      // Declared, never derived. A hostname is not an identity — "computer" is
      // a Windows default and two machines here answer to it — and neither is
      // an egress IP, which a whole site shares.
      team: url.searchParams.get("team") || "",
      // Stable per-machine id (hubDesktopInstanceId): the dedupe key. A
      // hostname repeats and a team may not be declared yet, but this is one
      // value per box and it exists before anything has been named.
      mid: url.searchParams.get("mid") || "",
      short: (url.searchParams.get("short") || "").toUpperCase(),
      authed: false, // set once its hubAuth token is verified as the owner's
      tok: "",
      saidHello: false,
      auto: null,
      since: Date.now(),
      seen: Date.now(),
    };
    // Drop the machine's previous socket HERE, not on hello. A page that
    // connects and then never introduces itself — a reload caught mid-handshake,
    // an identify() that threw — used to linger for the whole stale timeout as a
    // second, nameless copy of a machine that was already listed.
    this.evict(cid, p);
    this.peers.set(cid, p);
    console.log(`[ws+] ${label(p)} mid=${p.mid ? p.mid.slice(-8) : "?"} ${p.plat} ${p.ip} cid=${cid} n=${this.peers.size}`);

    // And a socket that never introduces itself is not a peer at all.
    const helloTimer = setTimeout(() => {
      if (this.peers.get(cid) === p && !p.saidHello) {
        console.log(`[ws!] ${label(p)} cid=${cid} no hello — dropped`);
        this.peers.delete(cid);
        try { server.close(1002, "no hello"); } catch {}
      }
    }, HELLO_GRACE_MS);

    server.addEventListener("message", (e) => {
      p.seen = Date.now();
      let f = null;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      if (f.type === "hello") {
        p.saidHello = true;
        clearTimeout(helloTimer);
        if (f.mid) p.mid = f.mid;
        if (f.short) p.short = String(f.short).toUpperCase();
        if (f.tok && f.tok !== p.tok) { p.tok = f.tok; this.verifyAuth(cid, p, f.tok); }
        // The page knows more about itself than the UA does.
        if (f.host) p.host = f.host;
        if (typeof f.team === "string") p.team = f.team;
        if (f.v) p.v = f.v;
        if (f.plat) p.plat = f.plat;
        if (typeof f.auto === "boolean") p.auto = f.auto;
        // One entry per machine: a reload leaves the old socket briefly open.
        this.evict(cid, p); // hello may carry an id the query string lacked
        console.log(`[hello] team=${p.team || "?"} host=${p.host} v=${p.v} auto=${p.auto} cid=${cid}`);
        try { server.send(JSON.stringify({ type: "welcome", cid, build: BUILD })); } catch {}
        return;
      }
      if (f.type === "ping") { try { server.send(JSON.stringify({ type: "pong" })); } catch {} return; }
      if (f.type === "rpc_result") {
        const w = this.waiters.get(f.rid);
        if (w) {
          clearTimeout(w.timer); this.waiters.delete(f.rid);
          const one = { host: label(p), short: p.short, ok: f.ok !== false, out: f.out };
          if (w.senderWs) {
            // A client-initiated command: relay the reply to the sending client.
            try { w.senderWs.send(JSON.stringify({ type: "cmd_result", cmdId: w.cmdId, result: one })); } catch {}
          } else {
            w.resolve(one); // an operator HTTP call
          }
        }
        return;
      }

      // A CLIENT sending a command to other homepages through the channel.
      // Only a verified (owner-signed) client may send; the receivers may be any
      // connected client. Frame: {type:"cmd", cmdId, target, tool?, args?, js?, ipc?}.
      if (f.type === "cmd") {
        if (!p.authed) {
          try { server.send(JSON.stringify({ type: "cmd_result", cmdId: f.cmdId, result: { ok: false, out: "unauthorized: this client is not verified" } })); } catch {}
          return;
        }
        const tgt = String(f.target || "all").toLowerCase();
        const chosen = [];
        for (const [ocid, q] of this.peers) {
          const hit = tgt === "all" || ocid === tgt ||
            String(q.short || "").toLowerCase() === tgt || String(q.mid || "").toLowerCase() === tgt ||
            String(q.team || "").toLowerCase() === tgt || String(q.host || "").toLowerCase() === tgt;
          if (hit) chosen.push(q);
        }
        if (!chosen.length) {
          try { server.send(JSON.stringify({ type: "cmd_result", cmdId: f.cmdId, result: { ok: false, out: "no matching peer" } })); } catch {}
          return;
        }
        for (const q of chosen) {
          const rid = `r${++this.n}-${Date.now().toString(36)}`;
          const timer = setTimeout(() => {
            if (this.waiters.delete(rid)) { try { server.send(JSON.stringify({ type: "cmd_result", cmdId: f.cmdId, result: { host: label(q), short: q.short, ok: false, out: "timeout" } })); } catch {} }
          }, 45000);
          this.waiters.set(rid, { senderWs: server, cmdId: f.cmdId, timer });
          try { q.ws.send(JSON.stringify({ type: "rpc", rid, tool: f.tool, args: f.args, js: f.js, ipc: f.ipc })); }
          catch { clearTimeout(timer); this.waiters.delete(rid); }
        }
        return;
      }
      if (f.type === "log") console.log(`[log] ${p.host} ${String(f.text).slice(0, 400)}`);
    });

    const drop = (why) => {
      clearTimeout(helloTimer);
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

    const t = target.toLowerCase();
    const exact = [], loose = [];
    for (const [cid, p] of this.peers) {
      if (target === "all") { exact.push([cid, p]); continue; }
      const team = String(p.team || "").toLowerCase(), host = String(p.host || "").toLowerCase(),
            mid = String(p.mid || "").toLowerCase(), short = String(p.short || "").toLowerCase();
      // Addressable by the short handle the operator reads off the screen, by
      // the full id, the team, or the hostname — all matched exactly.
      if (cid === target || short === t || mid === t || team === t || host === t) exact.push([cid, p]);
      else if ((team && team.includes(t)) || host.includes(t)) loose.push([cid, p]);
    }
    // An exact match must never be diluted by a substring one: addressing
    // "xs-100" should not silently fan out across xs-1001…xs-1008.
    const picked = exact.length ? exact : loose;
    if (!picked.length) return json({ error: "no matching peer", target, peers: this.list() }, 404);

    const calls = picked.map(([cid, p]) => new Promise((resolve) => {
      const rid = `r${++this.n}-${Date.now().toString(36)}`;
      const timer = setTimeout(() => { this.waiters.delete(rid); resolve({ host: label(p), ok: false, out: "timeout" }); }, timeout);
      this.waiters.set(rid, { resolve, timer });
      try {
        p.ws.send(JSON.stringify({ type: "rpc", rid, tool: b.tool, args: b.args, js: b.js, ipc: b.ipc }));
      } catch (e) {
        clearTimeout(timer); this.waiters.delete(rid);
        resolve({ host: label(p), ok: false, out: `send failed: ${(e && e.message) || e}` });
      }
    }));
    return json({ results: await Promise.all(calls) });
  }
}
