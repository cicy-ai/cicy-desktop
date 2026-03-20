# HTTP Server Examples

This directory contains HTML examples for testing with CiCy Desktop.

## Files

- `pyautogui-test.html` - Test page for PyAutoGUI automation

## Usage

### Start HTTP Server

```bash
# Using Python
cd examples/httpserver
python3 -m http.server 8889

# Or using MCP tool
cicy-rpc --json '{"name":"exec_shell","arguments":{"command":"cd ./examples/httpserver && python3 -m http.server 8889 > /dev/null 2>&1 & echo $!"}}'
```

### Open in Electron Window

```bash
cicy-rpc --json '{"name":"open_window","arguments":{"url":"http://localhost:8889/pyautogui-test.html"}}'
```

## PyAutoGUI Test Example

The `pyautogui-test.html` page demonstrates:
- Interactive buttons that log clicks
- Can be controlled by PyAutoGUI or CDP tools
- Shows click events in real-time

### Get Button Position

```bash
cicy-rpc --json '{"name":"get_element_client_bound","arguments":{"win_id":1,"selector":"#btn1"}}'
```

### Click with CDP

```bash
cicy-rpc --json '{"name":"cdp_click","arguments":{"win_id":1,"x":162,"y":230}}'
```

### Click with PyAutoGUI

```bash
# Install PyAutoGUI first
cicy-rpc --json '{"name":"exec_shell","arguments":{"command":"pip install pyautogui --break-system-packages"}}'

# Click button (adjust coordinates based on window position)
cicy-rpc --json '{"name":"exec_python","arguments":{"code":"import pyautogui; pyautogui.click(188, 303)"}}'
```

## Notes

- PyAutoGUI requires X11 display (works in Xvfb)
- Coordinates are screen-absolute (window position + element position)
- CDP tools work directly with element coordinates
