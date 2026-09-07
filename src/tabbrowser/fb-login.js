// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// fb-login.js — one-click Facebook login for the Facebook 矩阵 panel.
//
// The panel's "登录（自动填账密 + 提交）" button sends `panelcells:reload` with a
// synthetic id `fblogin-<accountIdx>`; panel-cells.js routes that here instead of
// reloading a cell. We read the profile's stored Facebook credential (email /
// password / TOTP secret), fill the login form in that profile's live
// facebook.com webContents, submit, then poll for the outcome — auto-filling the
// 2FA code from the TOTP secret. reCAPTCHA / human checkpoints are left to the
// operator (we only detect and report them).
//
// This lives in the app (registered at startup) rather than being hot-injected,
// so it survives app restarts. Credentials never leave the machine.

const { session, webContents } = require("electron");
const crypto = require("crypto");

// RFC 6238 TOTP (base32 secret → 6-digit code), Node crypto only.
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of String(secret || "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const epoch = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(epoch / 2 ** 32), 0);
  buf.writeUInt32BE(epoch >>> 0, 4);
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, "0");
}

// Read {email, pass, twofa} from the profile's stored "facebook" login record.
// note format (provisioned): "<FB号> · FB密码:<pass> · 2FA:<secret> · 邮箱密码:… · 备用:…"
function readCredential(accountIdx) {
  try {
    const store = require("../profiles/profile-store");
    const prof = store.getProfile("electron", accountIdx);
    const logins = prof && Array.isArray(prof.logins) ? prof.logins : [];
    const fb = logins.find((l) => String((l && l.name) || "").toLowerCase() === "facebook");
    if (!fb) return null;
    const m = String(fb.note || "").match(/FB密码[:：]\s*([^·]+)/);
    return {
      email: String(fb.username || fb.email || "").trim(),
      pass: m ? m[1].trim() : "",
      twofa: String(fb.twofa || "").replace(/\s/g, ""),
    };
  } catch (e) {
    return null;
  }
}

// Native-setter fill so React/controlled inputs register the value + events.
const FILL_HELPER = `function __fbset(el, v){const p=Object.getPrototypeOf(el),d=Object.getOwnPropertyDescriptor(p,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

async function fbLogin(accountIdx) {
  const idx = Number(accountIdx);
  if (!Number.isInteger(idx) || idx <= 0) return { ok: false, err: "bad idx" };
  const cred = readCredential(idx);
  if (!cred || !cred.email || !cred.pass) return { ok: false, err: "no cred" };
  const part = "persist:sandbox-" + idx;
  const ses = session.fromPartition(part);
  const wc = webContents.getAllWebContents().find((w) => {
    try { return /facebook\.com/.test(w.getURL()) && w.session === ses; } catch (e) { return false; }
  });
  if (!wc) return { ok: false, err: "no fb cell" };
  const ev = (code) => wc.executeJavaScript(code, true);

  const fill = await ev(`(()=>{${FILL_HELPER}
    const e=document.querySelector('input[name=email],input#email,input[type=email]'),p=document.querySelector('input[name=pass],input#pass,input[type=password]');
    if(!e||!p)return{ok:false};
    e.focus();__fbset(e,${JSON.stringify(cred.email)});p.focus();__fbset(p,${JSON.stringify(cred.pass)});
    const b=[...document.querySelectorAll('button,[role=button]')].find(x=>/^登录$|^Log In$|^Log in$/.test((x.textContent||'').trim()))||document.querySelector('button[type=submit]');
    if(b){b.click();}else{const f=document.querySelector('form');if(f)(f.requestSubmit?f.requestSubmit():f.submit());}
    return{ok:true};})()`).catch(() => ({ ok: false }));
  if (!fill || !fill.ok) return { ok: false, err: "no login form" };

  let state = "pending";
  for (let i = 0; i < 9; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await ev(`(()=>({cu:document.cookie.includes('c_user'),cap:/recaptcha|captcha|人机|robot|安全验证/i.test(document.documentElement.innerHTML),code:!!document.querySelector('input[name=approvals_code],input[autocomplete=one-time-code],input[name=code]')}))()`).catch(() => ({}));
    if (st.cu) { state = "logged_in"; break; }
    if (st.code) {
      const t = totp(cred.twofa);
      await ev(`(()=>{${FILL_HELPER}
        const c=document.querySelector('input[name=approvals_code],input[autocomplete=one-time-code],input[name=code]');
        if(c){__fbset(c,'${t}');const b=[...document.querySelectorAll('button,[role=button]')].find(x=>/继续|Continue|提交|Submit|下一步/i.test(x.textContent||''));if(b)b.click();}})()`).catch(() => {});
      state = "totp";
      continue;
    }
    if (st.cap) { state = "need_recaptcha"; break; }
  }
  return { ok: true, idx, state };
}

// Route `fblogin-<idx>` reload ids here. Returns true if handled.
function maybeHandleReload(id) {
  const s = String(id || "");
  if (!s.startsWith("fblogin-")) return false;
  const idx = Number(s.slice("fblogin-".length));
  fbLogin(idx).then((r) => {
    try { require("electron-log").info(`[fblogin] #${idx} ${JSON.stringify(r)}`); } catch (e) {}
  });
  return true;
}

module.exports = { fbLogin, maybeHandleReload };
