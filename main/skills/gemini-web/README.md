# Gemini Web 自动化

Gemini Web 自动化工具，支持截图粘贴提问、获取回复。

## MCP 工具

直接使用 curl-rpc:

```bash
# 状态
curl-rpc gemini_web_status
curl-rpc is_gemini_logged

# 粘贴图片 (先截图到剪切版，再粘贴到输入框)
curl-rpc webpage_screenshot_to_clipboard
curl-rpc gemini_paste_image

# 设置问题
curl-rpc gemini_web_set_prompt text="问题"

# 发送
curl-rpc gemini_web_click_send

# 完整流程 (发送+等待回复)
curl-rpc gemini_web_ask text="你好"

# 清理输入框
curl-rpc gemini_web_clear_prompt

# 确保窗口在 Gemini 页面
curl-rpc gemini_web_ensure
```

## 完整示例：截图提问

```bash
# 1. 打开目标网页截图
curl-rpc open_window url=https://example.com
curl-rpc webpage_screenshot_to_clipboard

# 2. 打开 Gemini 窗口
curl-rpc open_window url=https://gemini.google.com/app reuseWindow=false

# 3. 粘贴图片到 Gemini
curl-rpc gemini_paste_image

# 4. 设置问题并发送
curl-rpc gemini_web_set_prompt text="描述这个网页的视觉风格"
curl-rpc gemini_web_click_send

# 5. 等待回复 (查看状态)
curl-rpc gemini_web_status
```

## 多窗口支持

所有工具支持 `win_id` 参数:

```bash
# 窗口1截图
curl-rpc webpage_screenshot_to_clipboard win_id=1

# 窗口2粘贴
curl-rpc gemini_paste_image win_id=2
```

## 依赖

- electron-mcp 服务
- 登录 Gemini Web
