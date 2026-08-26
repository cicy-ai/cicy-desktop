# Telegram Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `Telegram 矩阵` preset into a profile manager with a left-side profile table and a phone-sized Telegram Web preview on the right.

**Architecture:** Keep the system profile panel as renderer chrome and place one main-process `BrowserView` above its preview slot. The selected item supplies `persist:sandbox-N`; profile creation and proxy changes go through `profile-store`, and the BrowserView is rebuilt/reloaded when its profile or proxy changes.

**Tech Stack:** Electron BrowserView, IPC/contextBridge, CommonJS, HTML/CSS/JavaScript, Node test runner.

**Spec:** Approved in chat on 2026-08-24: unlimited Electron profiles, one item per profile, custom per-profile proxy, phone-sized Telegram preview.

## Global Constraints

- Ordinary `面板` behavior remains unchanged.
- Telegram profile data uses `persist:sandbox-<accountIdx>` and existing `~/data/electron/account-<N>.json` persistence.
- New profiles default to `http://127.0.0.1:20001`; each profile can use a custom `http://`, `https://`, or `socks5://` proxy, or direct mode.
- The Telegram target is `https://web.telegram.org/k/`.
- Profile 0 and reserved profile 9 must not appear in the matrix.

---

### Task 1: Matrix preset routing

**Files:**
- Modify: `src/tabbrowser/panel-presets.js`
- Modify: `src/tools/tab-browser-tools.js`
- Modify: `src/tabbrowser/newtab-protocol.js`
- Create: `src/tabbrowser/telegram-matrix.html`
- Test: `test/telegram-matrix.test.js`

**Interfaces:**
- Produces: `resolvePanelPreset("telegram-matrix")` with a `query` field; `cicyui://panel/<id>?preset=telegram-matrix` serves `telegram-matrix.html`.

- [ ] Write a failing test asserting the Telegram preset URL query and dedicated HTML routing contract.
- [ ] Run `node --test test/telegram-matrix.test.js` and confirm the missing query/page behavior fails.
- [ ] Add the preset query, append it in `openPanelTab`, and select `telegram-matrix.html` in the protocol handler.
- [ ] Run the test and confirm it passes.

### Task 2: Profile creation and custom proxy service

**Files:**
- Create: `src/tabbrowser/telegram-matrix-profiles.js`
- Modify: `src/tabbrowser/panel-cells.js`
- Modify: `src/tabbrowser/panel-preload.js`
- Test: `test/telegram-matrix.test.js`

**Interfaces:**
- Produces: `listTelegramProfiles()`, `addTelegramProfile(defaultProxy)`, `setTelegramProfileProxy(accountIdx, proxy)`.
- IPC: `panelcells:profiles`, `panelcells:add-profile`, `panelcells:set-profile-proxy`.

- [ ] Write failing tests for next-ID allocation, default proxy persistence, accepted proxy schemes, direct mode, and invalid proxy rejection.
- [ ] Run the focused test and confirm each new behavior fails for the expected reason.
- [ ] Implement the pure validation/allocation service and IPC handlers backed by `profile-store`.
- [ ] Apply proxy immediately with `session.setProxy`, rebuild the selected profile view when needed, and expose methods through `panelAPI`.
- [ ] Run focused and profile-store tests and confirm they pass.

### Task 3: Table and phone preview UI

**Files:**
- Modify: `src/tabbrowser/telegram-matrix.html`
- Test: `test/telegram-matrix.test.js`

**Interfaces:**
- Consumes: `panelAPI.profiles()`, `panelAPI.addProfile()`, `panelAPI.setProfileProxy()`, and `panelAPI.sync([{ id: "telegram-preview", url, profile, rect }])`.

- [ ] Write a failing DOM-contract test for the profile table, add button, proxy editor, empty state, and phone preview slot.
- [ ] Run the test and confirm the absent controls fail.
- [ ] Implement rendering, first-profile selection, add-profile flow, per-row proxy editing, status feedback, and a single responsive 390-by-844 preview slot.
- [ ] Sync only the selected profile to the native BrowserView and preserve the list selection locally.
- [ ] Run the focused test and confirm it passes.

### Task 4: Integration verification

**Files:**
- Test: `test/panel-launcher.test.js`
- Test: `test/telegram-matrix.test.js`

**Interfaces:**
- Verifies the complete menu-to-matrix flow without changing ordinary panels.

- [ ] Run `node --test test/panel-launcher.test.js test/telegram-matrix.test.js`.
- [ ] Run syntax checks for every changed JavaScript file and `git diff --check`.
- [ ] Restart `C:\projects\start-cicy-desktop-win.bat` and wait for the source Electron client to reconnect.
- [ ] Open `Telegram 矩阵`, inspect its DOM via `agent-electron`, and confirm profile selection produces one Telegram BrowserView in the selected partition.
