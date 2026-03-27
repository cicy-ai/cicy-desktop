# CiCy Desktop Service

This skill is about running and checking the local CiCy Desktop service.

Use `cicy` / `cicy-desktop` for service lifecycle.
Use `cicy-rpc` for tool calls after the service is running.

## Start the local service

```bash
cicy start
# or
npm start
```

Equivalent alias:

```bash
cicy-desktop start
```

## Common service commands

```bash
cicy start
cicy stop
cicy status
cicy restart
cicy logs
```

## Verify the worker after startup

```bash
cicy-rpc ping
cicy-rpc tools
cicy-rpc open_window url=https://example.com
```

## Ports

Current desktop lifecycle CLI options:

```bash
cicy --master-port 8200 --port 8201
```

Defaults:
- master port: `8100`
- worker port: `8101`

## Notes

- `cicy --json` / `cicy -j` is not supported
- RPC/tool commands moved to `cicy-rpc`
- `cicy logs` follows cluster logs from `~/logs`

## Troubleshooting

### Service is not running

```bash
cicy status
```

If needed, start or restart it:

```bash
cicy start
cicy restart
```

### RPC calls fail after startup

First verify the service, then verify RPC:

```bash
cicy status
cicy-rpc ping
```

### Need logs

```bash
cicy logs
```

## Related docs

- [Root README](../../README.md)
- [CLI split](../cicy-cli/README.md)
- [RPC CLI README](../../packages/cicy-rpc/README.md)
