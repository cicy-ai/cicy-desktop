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
docker exec electron-rcp tail -f /home/electron/logs/cicy-desktop.log
```

### Use cicy-rpc from host
```bash
# Set token on host
echo '{"api_token":"your-token-here"}' > ~/global.json

# Test connection
cicy-rpc ping

# Open window
cicy-rpc open_window url=https://google.com

# Take screenshot
cicy-rpc webpage_snapshot win_id=1
```

### Extract screenshot to host
```bash
curl -s http://localhost:8101/rpc/tools/call \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -H "Content-Type: application/json" \
  -d '{"name":"webpage_snapshot","arguments":{"win_id":1}}' | \
  jq -r '.result.content[] | select(.type=="image") | .data' | \
  base64 -d > screenshot.png
```

### Execute shell commands
```bash
cicy-rpc exec_shell command="pip3 install package-name --break-system-packages"
```

## Environment Variables

- `TOKEN`: Authentication token (default: your-token-here)
- `DISPLAY`: X display (default: :99)

## Stop and Remove

```bash
docker stop electron-rcp
docker rm electron-rcp
```

