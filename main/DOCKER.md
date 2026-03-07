# Electron RCP Docker

Docker image for electron-rcp with browser automation capabilities.

## Features

- Node.js 22
- Electron with Xvfb (headless)
- Python 3 + pip
- Non-root user (electron)
- Port 8101 exposed

## Build

```bash
docker build -t electron-rcp .
```

## Run

```bash
docker run -d \
  --name electron-rcp \
  -p 8101:8101 \
  -e TOKEN=your-token-here \
  --cap-add=SYS_ADMIN \
  electron-rcp
```

## Usage

### Check status
```bash
docker exec electron-rcp electron-rpc status
```

### View logs
```bash
docker logs electron-rcp
# or
docker exec electron-rcp tail -f /home/electron/logs/electron-mcp.log
```

### Use curl-rpc from host
```bash
# Set token on host
echo "your-token-here" > ~/data/electron/token.txt

# Test connection
curl-rpc ping

# Open window
curl-rpc open_window url=https://google.com

# Take screenshot
curl-rpc webpage_snapshot win_id=1
```

### Extract screenshot to host
```bash
curl -s http://localhost:8101/rpc/tools/call \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -H "Content-Type: application/json" \
  -d '{"name":"webpage_snapshot","arguments":{"win_id":1}}' | \
  jq -r '.result.content[] | select(.type=="image") | .data' | \
  base64 -d > screenshot.png
```

### Execute shell commands
```bash
curl-rpc exec_shell command="pip3 install package-name --break-system-packages"
```

## Environment Variables

- `TOKEN`: Authentication token (default: your-token-here)
- `DISPLAY`: X display (default: :99)

## Stop and Remove

```bash
docker stop electron-rcp
docker rm electron-rcp
```

