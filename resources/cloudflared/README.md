# cloudflared bundle (macOS)

`main.js` → `seedCloudflaredToLocalBin()` copies the arch-matching binary here to
`~/.local/bin/cloudflared` on app startup (mac/linux), so cicy-code's cft tunnel
(`--cft-token`) finds it via `LookPath` and never has to download from GitHub.

**Windows needs nothing here** — the docker image already ships cloudflared.

## Required files (per-arch, NOT in git — build assets)

- `cloudflared-darwin-arm64`  (Apple Silicon)
- `cloudflared-darwin-x64`    (Intel)

Get them from the official release (extract the `cloudflared` binary from the
`.tgz`), `chmod +x`, and drop them here before packaging:

```
curl -fsSL -o cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
tar -xzf cf.tgz && mv cloudflared cloudflared-darwin-arm64 && chmod +x cloudflared-darwin-arm64
# repeat for amd64 → cloudflared-darwin-x64
```

`electron-builder` ships this dir to `Resources/cloudflared/` via `build.extraResources`.
The binaries are `.gitignore`d (large); place them at build time.
