# CiCy Desktop Skills

Helper skills bundled with CiCy Desktop. Each subfolder is a self-contained skill
with its own `README.md` and an executable entry script.

## Two CLIs, two jobs

- **`cicy` / `cicy-desktop`** — desktop / cluster **lifecycle** only
  (`start`, `stop`, `status`, `restart`, `logs`).
- **`cicy-rpc`** — **RPC / tool calls** against a running worker
  (`cicy-rpc ping`, `cicy-rpc tools`, `cicy-rpc open_window url=…`).

> 管服务用 `cicy`,调工具用 `cicy-rpc`。RPC 命令不要再用 `cicy` 前缀。

```bash
cicy start                 # bring the local worker up
cicy-rpc ping              # → Pong
cicy-rpc tools             # list available tools
cicy-rpc open_window url=https://example.com
```

Config lives in `~/global.json`. Select a node with `CICY_NODE=<name>` (defaults
to `local`); see `cicy-desktop-service` for details.

## Skills

| Skill | Entry | What it does |
|-------|-------|--------------|
| [`cicy-desktop-service`](./cicy-desktop-service) | `cicy-desktop-service.sh` | Run / check the local CiCy Desktop service (lifecycle + verify). |
| [`cicy-rpc`](./cicy-rpc) | `cicy-rpc` | Thin wrapper that execs the bundled `bin/cicy-rpc` (compat shim). |
| [`chrome-cdp`](./chrome-cdp) | `chrome-cdp` | Launch Chrome with a remote-debugging port + per-account profile isolation. |
| [`multi-account`](./multi-account) | `multi-account.sh` | Open/list/close isolated browser windows (separate cookies/session per account). |
| [`telegram-web`](./telegram-web) | `telegram-web.sh` | Telegram Web automation (open, QR login, list chats, send). |
| [`chatgpt-web`](./chatgpt-web) | `chatgpt-web.sh` | ChatGPT Web automation (status, conversations, ask, open). |

## Quick reference

```bash
# Service lifecycle
bash cicy-desktop-service/cicy-desktop-service.sh start
bash cicy-desktop-service/cicy-desktop-service.sh status

# Chrome with CDP (account, port, url)
bash chrome-cdp/chrome-cdp 1 9221 https://account.apple.com

# Isolated windows
bash multi-account/multi-account.sh open https://web.telegram.org/k/ work
bash multi-account/multi-account.sh list

# Telegram Web
bash telegram-web/telegram-web.sh open
bash telegram-web/telegram-web.sh send "Saved Messages" "Hello"

# ChatGPT Web
bash chatgpt-web/chatgpt-web.sh ask 你好
```
