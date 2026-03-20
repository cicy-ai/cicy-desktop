# CiCy Desktop REST API - All Tools

## Available Tools

### ping

```bash
curl -X POST http://localhost:8101/rpc/ping \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_windows

```bash
curl -X POST http://localhost:8101/rpc/get_windows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_window_info

```bash
curl -X POST http://localhost:8101/rpc/get_window_info \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### open_window

```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### close_window

```bash
curl -X POST http://localhost:8101/rpc/close_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### load_url

```bash
curl -X POST http://localhost:8101/rpc/load_url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_title

```bash
curl -X POST http://localhost:8101/rpc/get_title \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### control_electron_BrowserWindow

```bash
curl -X POST http://localhost:8101/rpc/control_electron_BrowserWindow \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### control_electron_WebContents

```bash
curl -X POST http://localhost:8101/rpc/control_electron_WebContents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_console_logs

```bash
curl -X POST http://localhost:8101/rpc/get_console_logs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_requests

```bash
curl -X POST http://localhost:8101/rpc/get_requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### filter_requests

```bash
curl -X POST http://localhost:8101/rpc/filter_requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_request_detail

```bash
curl -X POST http://localhost:8101/rpc/get_request_detail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### session_download_url

```bash
curl -X POST http://localhost:8101/rpc/session_download_url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### webpage_screenshot_to_clipboard

```bash
curl -X POST http://localhost:8101/rpc/webpage_screenshot_to_clipboard \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### webpage_snapshot

```bash
curl -X POST http://localhost:8101/rpc/webpage_snapshot \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_request_urls

```bash
curl -X POST http://localhost:8101/rpc/get_request_urls \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_request_detail_by_url

```bash
curl -X POST http://localhost:8101/rpc/get_request_detail_by_url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### clear_requests

```bash
curl -X POST http://localhost:8101/rpc/clear_requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_click

```bash
curl -X POST http://localhost:8101/rpc/cdp_click \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_dblclick

```bash
curl -X POST http://localhost:8101/rpc/cdp_dblclick \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_key

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_key \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_enter

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_enter \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_backspace

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_backspace \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_copy

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_copy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_paste

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_paste \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_selectall

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_selectall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_press_cut

```bash
curl -X POST http://localhost:8101/rpc/cdp_press_cut \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_type_text

```bash
curl -X POST http://localhost:8101/rpc/cdp_type_text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_scroll

```bash
curl -X POST http://localhost:8101/rpc/cdp_scroll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### cdp_sendcmd

```bash
curl -X POST http://localhost:8101/rpc/cdp_sendcmd \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```


### exec_js

```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### get_element_client_bound

```bash
curl -X POST http://localhost:8101/rpc/get_element_client_bound \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```

### show_float_div

```bash
curl -X POST http://localhost:8101/rpc/show_float_div \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{}'
```


## Common Examples with Parameters

### open_window
```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"url":"https://example.com","accountIdx":0}'
```

### close_window
```bash
curl -X POST http://localhost:8101/rpc/close_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1}'
```

### exec_js
```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1,"code":"document.title"}'
```

### cdp_click
```bash
curl -X POST http://localhost:8101/rpc/cdp_click \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1,"selector":"button.submit"}'
```

### cdp_type_text
```bash
curl -X POST http://localhost:8101/rpc/cdp_type_text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1,"selector":"input[name=username]","text":"myuser"}'
```

### load_url
```bash
curl -X POST http://localhost:8101/rpc/load_url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1,"url":"https://google.com"}'
```

### get_window_info
```bash
curl -X POST http://localhost:8101/rpc/get_window_info \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1}'
```

### cdp_scroll
```bash
curl -X POST http://localhost:8101/rpc/cdp_scroll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1,"x":0,"y":500}'
```

### get_console_logs
```bash
curl -X POST http://localhost:8101/rpc/get_console_logs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1}'
```

### get_requests
```bash
curl -X POST http://localhost:8101/rpc/get_requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .api_token ~/global.json)" \
  -d '{"win_id":1}'
```
