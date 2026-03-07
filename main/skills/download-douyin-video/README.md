# 抖音视频下载

使用 `session_download_url` 自动下载抖音视频。

## 快速开始

```bash
# 1. 打开抖音视频页面
curl-rpc open_window url=https://www.douyin.com/video/7594434780347813155

# 2. 等待页面加载（10秒）
sleep 10

# 3. 获取视频URL并下载
VIDEO_URL=$(curl-rpc exec_js win_id=1 code='document.querySelector("video")?.currentSrc?.split(",")[0]' | grep -o 'https://[^"]*' | head -1)

curl-rpc session_download_url url="$VIDEO_URL" save_path=/tmp/douyin-video.mp4 timeout=60000
```

## 一键下载脚本

```bash
#!/bin/bash
VIDEO_PAGE="https://www.douyin.com/video/7594434780347813155"

# 打开页面
curl-rpc open_window url="$VIDEO_PAGE"
sleep 10

# 获取视频URL
VIDEO_URL=$(curl-rpc exec_js win_id=1 code='document.querySelector("video")?.currentSrc?.split(",")[0]' | grep -o 'https://[^"]*' | head -1)

echo "视频URL: $VIDEO_URL"

# 下载视频
curl-rpc session_download_url url="$VIDEO_URL" save_path=/tmp/douyin-$(date +%s).mp4 timeout=60000

echo "✅ 下载完成: /tmp/douyin-*.mp4"
```

## 查看下载进度

```bash
# 实时查看下载日志
tail -f /tmp/electron-mcp-8101.log | grep -i download

# 查看所有下载记录
curl-rpc get_downloads

# 查看特定下载
curl-rpc get_download id=1
```

## 批量下载

```bash
#!/bin/bash
VIDEOS=(
  "https://www.douyin.com/video/7594434780347813155"
  "https://www.douyin.com/video/另一个视频ID"
)

for url in "${VIDEOS[@]}"; do
  curl-rpc open_window url="$url"
  sleep 10
  
  VIDEO_URL=$(curl-rpc exec_js win_id=1 code='document.querySelector("video")?.currentSrc?.split(",")[0]' | grep -o 'https://[^"]*' | head -1)
  
  curl-rpc session_download_url url="$VIDEO_URL" save_path="/tmp/$(basename $url).mp4" timeout=60000
  
  sleep 5
done
```

## 常见问题

**Q: 下载失败怎么办？**
- 增加等待时间到15秒
- 检查视频URL是否过期（重新获取）
- 查看下载日志：`tail -f /tmp/electron-mcp-8101.log`

**Q: 如何获取视频标题？**
```bash
curl-rpc exec_js win_id=1 code='document.title'
```

**Q: 下载超时怎么办？**
- 增加 `timeout` 参数：`timeout=120000` (120秒)
- 检查网络连接

**Q: 如何清空下载记录？**
```bash
curl-rpc clear_downloads
```
