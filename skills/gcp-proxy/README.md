# gcp-proxy

GCP SSH SOCKS5 代理管理工具。

## 用法

```bash
gcp-proxy start    # 启动代理（默认 127.0.0.1:1080）
gcp-proxy stop     # 停止代理
gcp-proxy status   # 查看状态并测试连接
```

## 参数

```bash
gcp-proxy [start|stop|status|list] [host] [port]
```

- `host`: ~/.ssh/config 中的 Host（默认 `gcp-proxy`）
- `port`: 本地 SOCKS5 端口（默认 `1080`）

## 安装

```bash
ln -s /Users/ton/Desktop/cicy-desktop/skills/gcp-proxy/gcp-proxy ~/.local/bin/gcp-proxy
chmod +x /Users/ton/Desktop/cicy-desktop/skills/gcp-proxy/gcp-proxy
```
