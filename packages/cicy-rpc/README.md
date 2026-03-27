# cicy-rpc

`cicy-rpc` is the **only supported CLI** for calling CiCy Desktop worker RPC tools.

- Use `cicy` / `cicy-desktop` for **desktop / cluster lifecycle** (start/stop/status/logs)
- Use `cicy-rpc` for **RPC/tool calls** (ping/tools/open_window/exec_js/...)

See also: [CLI split](../../skills/cicy-cli/README.md)

## Installation / where it comes from

In this repo, the `cicy-rpc` executable is provided by the root package (`bin/cicy-rpc`) and runs the RPC CLI implementation in `src/cli/rpc.js`.

## Commands

```bash
cicy-rpc init
cicy-rpc tools
cicy-rpc tools <tool_name>
cicy-rpc <tool_name> [key=value ...]
```

Options:

```bash
-j, --json     Print raw JSON result
-h, --help     Show help
-v, --version  Show version
```

Examples:

```bash
cicy-rpc init
cicy-rpc tools
cicy-rpc tools open_window
cicy-rpc ping
cicy-rpc open_window url=https://example.com
cicy-rpc -j get_window_info win_id=1
```

## Config (canonical)

`cicy-rpc` reads `~/global.json`.

`cicy-rpc init` creates a starter config if it does not exist.

Canonical format:

```json
{
  "api_token": "your-default-token",
  "cicyDesktopNodes": {
    "local": {
      "api_token": "",
      "base_url": "http://localhost:8101"
    },
    "windows": {
      "api_token": "your-windows-token",
      "base_url": "http://windows-host:8101"
    }
  }
}
```

Token resolution order:

1. `cicyDesktopNodes.<name>.api_token`
2. top-level `api_token`

## Node selection (multi-node)

Select a node with `CICY_NODE=<name>` (default: `local`).

```bash
cicy-rpc ping
CICY_NODE=windows cicy-rpc ping
CICY_NODE=windows cicy-rpc get_windows
```

If a node name is missing, `cicy-rpc` will error and print the available node names.

## Calling tools

Tool calls use a simple `key=value` syntax:

```bash
cicy-rpc open_window url=https://example.com reuseWindow=true accountIdx=0
```

Value parsing rules (from `src/cli/rpc.js`):

- `true` / `false` / `null` are parsed as booleans / null
- numbers like `123` are parsed as numbers
- JSON objects/arrays are parsed when the value looks like `{...}` or `[...]`

Example (JSON value):

```bash
cicy-rpc exec_js win_id=1 code='({ title: document.title, url: location.href })'
```

## Output formats

- Default output: prints the `result.content` items in a readable way when available
- `--json` / `-j`: prints the full JSON response (useful for scripts)

## Troubleshooting

### `fetch failed`
The node is unreachable (wrong `base_url`, worker not running, network issue).

Try:

```bash
cicy-rpc ping
CICY_NODE=windows cicy-rpc ping
```

### `HTTP 401 Unauthorized`
The URL is reachable but the token is wrong/missing.

Check `~/global.json`:
- `api_token`
- `cicyDesktopNodes.<name>.api_token`

Then retry:

```bash
cicy-rpc ping
```

### Tool not found
List tools from the worker:

```bash
cicy-rpc tools
```

## Related docs

- [Root README](../../README.md)
- [REST API notes](../../docs/REST-API.md)
