# Chrome CDP Skill

启动 Chrome 并开启远程调试端口，支持多账户 profile 隔离。

## 安装

```bash
cp skills/chrome-cdp/chrome-cdp ~/.local/bin/chrome-cdp
chmod +x ~/.local/bin/chrome-cdp
```

## 使用

```bash
# chrome-cdp [account] [port] [url]
chrome-cdp                                          # account=0, port=9220
chrome-cdp 0 9220 https://www.icloud.com/mail      # account 0
chrome-cdp 1 9221 https://account.apple.com        # account 1
```

## Profile 映射

| account | profile |
|---------|---------|
| 0 | Default |
| 1 | Profile 1 |
| 2 | Profile 2 |

数据目录：`~/ChromeCDP`
CDP 地址：`http://localhost:<port>`
