# TODO: Anti-Detection & Reliability Enhancement

## 🎯 目标
增强 CDP 和模拟控制的可靠性，降低被检测风险，提高自动化成功率。

## 📋 任务清单

### Phase 1: 反检测基础 (1-2 天)

- [ ] **WebDriver 隐藏**
  - [ ] 修改 `navigator.webdriver` 为 undefined
  - [ ] 隐藏 `window.chrome.runtime`
  - [ ] 修改 `navigator.plugins` 和 `navigator.languages`
  - [ ] 测试工具：https://bot.sannysoft.com/

- [ ] **Canvas 指纹伪装**
  - [ ] 随机化 Canvas 渲染结果
  - [ ] 随机化 WebGL 指纹
  - [ ] 随机化 AudioContext 指纹
  - [ ] 测试工具：https://browserleaks.com/canvas

- [ ] **User-Agent 管理**
  - [ ] 内置常见 UA 列表（Chrome/Firefox/Safari）
  - [ ] 支持自定义 UA
  - [ ] UA 与其他特征一致性检查
  - [ ] 工具：`set_user_agent` 

### Phase 2: 行为模拟 (2-3 天)

- [ ] **鼠标轨迹模拟**
  - [ ] 贝塞尔曲线鼠标移动
  - [ ] 随机速度和加速度
  - [ ] 偶尔的抖动和停顿
  - [ ] 工具：`cdp_move_mouse_human`

- [ ] **随机延迟**
  - [ ] 操作间随机延迟（100-500ms）
  - [ ] 页面加载等待（随机 1-3 秒）
  - [ ] 输入速度随机化（50-150ms/字符）
  - [ ] 工具：`cdp_type_text_human`

- [ ] **真人行为模拟**
  - [ ] 随机滚动页面
  - [ ] 偶尔移动鼠标到无关元素
  - [ ] 随机点击空白区域
  - [ ] 工具：`simulate_human_behavior`

### Phase 3: 混合控制模式 (2-3 天)

- [ ] **智能控制器**
  - [ ] 自动选择 CDP 或系统级控制
  - [ ] 根据检测风险动态切换
  - [ ] 失败自动重试（切换方法）
  - [ ] 工具：`hybrid_click`, `hybrid_type`

- [ ] **元素定位增强**
  - [ ] CDP 选择器定位（优先）
  - [ ] 图像识别定位（备用）
  - [ ] OCR 文字定位（备用）
  - [ ] 工具：`find_element_smart`

- [ ] **操作验证**
  - [ ] 点击后验证元素状态
  - [ ] 输入后验证文本内容
  - [ ] 截图对比验证
  - [ ] 工具：`verify_action`

### Phase 4: 图像识别集成 (3-4 天)

- [ ] **OCR 文字识别**
  - [ ] 安装 Tesseract
  - [ ] 封装 OCR 工具
  - [ ] 支持中英文识别
  - [ ] 工具：`ocr_find_text`, `ocr_read_screen`

- [ ] **模板匹配**
  - [ ] 安装 OpenCV (opencv4nodejs)
  - [ ] 模板图片管理
  - [ ] 相似度阈值配置
  - [ ] 工具：`find_image`, `wait_for_image`

- [ ] **颜色检测**
  - [ ] 按颜色查找元素
  - [ ] 颜色变化监控
  - [ ] 工具：`find_by_color`

- [ ] **UI 元素识别**
  - [ ] 按钮识别（形状+文字）
  - [ ] 输入框识别
  - [ ] 图标识别
  - [ ] 工具：`detect_ui_elements`

### Phase 5: 可靠性测试 (2-3 天)

- [ ] **反爬虫测试**
  - [ ] 测试常见反爬虫网站
  - [ ] Cloudflare Challenge
  - [ ] reCAPTCHA 检测
  - [ ] 记录检测率

- [ ] **成功率统计**
  - [ ] 操作成功率监控
  - [ ] 失败原因分析
  - [ ] 性能指标收集
  - [ ] Dashboard 展示

- [ ] **压力测试**
  - [ ] 并发 10+ Agent 测试
  - [ ] 长时间运行稳定性
  - [ ] 内存泄漏检测
  - [ ] 资源使用监控

### Phase 6: 文档和示例 (1-2 天)

- [ ] **使用文档**
  - [ ] 反检测最佳实践
  - [ ] 混合控制模式说明
  - [ ] 图像识别使用指南
  - [ ] 常见问题解答

- [ ] **示例代码**
  - [ ] 反检测配置示例
  - [ ] 复杂场景自动化示例
  - [ ] 图像识别示例
  - [ ] 错误处理示例

- [ ] **测试用例**
  - [ ] 单元测试
  - [ ] 集成测试
  - [ ] E2E 测试

## 🛠️ 新增工具列表

### 反检测工具
```javascript
// 配置反检测
set_anti_detect({
  hideWebdriver: true,
  randomCanvas: true,
  randomUA: true
})

// 设置 User-Agent
set_user_agent({
  win_id: 1,
  userAgent: "Mozilla/5.0 ..."
})

// 注入反检测脚本
inject_stealth_scripts({ win_id: 1 })
```

### 行为模拟工具
```javascript
// 人类化鼠标移动
cdp_move_mouse_human({
  win_id: 1,
  x: 500,
  y: 300,
  duration: 1000  // 移动时间
})

// 人类化输入
cdp_type_text_human({
  win_id: 1,
  text: "Hello",
  minDelay: 50,
  maxDelay: 150
})

// 模拟真人行为
simulate_human_behavior({
  win_id: 1,
  duration: 5000,  // 持续 5 秒
  actions: ["scroll", "move", "pause"]
})
```

### 混合控制工具
```javascript
// 智能点击（自动选择方法）
hybrid_click({
  win_id: 1,
  selector: "button.submit",  // 优先 CDP
  fallback: "image",          // 失败时用图像
  antiDetect: true
})

// 智能输入
hybrid_type({
  win_id: 1,
  selector: "input#username",
  text: "user123",
  method: "auto"  // auto/cdp/system
})

// 智能元素查找
find_element_smart({
  win_id: 1,
  selector: "button",         // CSS 选择器
  text: "登录",               // OCR 文字
  image: "login_button.png",  // 模板图片
  color: "#FF0000"            // 颜色
})
```

### 图像识别工具
```javascript
// OCR 文字识别
ocr_find_text({
  win_id: 1,
  text: "登录",
  lang: "chi_sim+eng"
})

// 读取屏幕文字
ocr_read_screen({
  win_id: 1,
  region: { x: 0, y: 0, width: 800, height: 600 }
})

// 图像模板匹配
find_image({
  win_id: 1,
  template: "button.png",
  threshold: 0.8
})

// 等待图像出现
wait_for_image({
  win_id: 1,
  template: "success.png",
  timeout: 10000
})

// 按颜色查找
find_by_color({
  win_id: 1,
  color: "#FF0000",
  tolerance: 10
})

// UI 元素检测
detect_ui_elements({
  win_id: 1,
  types: ["button", "input", "icon"]
})
```

### 验证工具
```javascript
// 验证操作结果
verify_action({
  win_id: 1,
  action: "click",
  selector: "button",
  expect: {
    urlChange: true,
    elementVisible: ".success"
  }
})

// 截图对比
compare_screenshots({
  win_id: 1,
  before: "before.png",
  after: "after.png",
  threshold: 0.95
})
```

## 📊 验收标准

### 反检测效果
- [ ] bot.sannysoft.com 检测通过率 > 90%
- [ ] browserleaks.com 指纹随机化成功
- [ ] Cloudflare Challenge 通过率 > 80%

### 可靠性指标
- [ ] 操作成功率 > 95%
- [ ] 图像识别准确率 > 90%
- [ ] OCR 识别准确率 > 85%

### 性能指标
- [ ] 人类化操作延迟 < 2 秒
- [ ] 图像识别响应 < 1 秒
- [ ] OCR 识别响应 < 500ms

## 🔗 参考资料

### 反检测
- [puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth)
- [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
- [Bot Detection Tests](https://bot.sannysoft.com/)

### 图像识别
- [Tesseract.js](https://github.com/naptha/tesseract.js)
- [opencv4nodejs](https://github.com/justadudewhohacks/opencv4nodejs)
- [node-tesseract-ocr](https://github.com/zapolnoch/node-tesseract-ocr)

### 行为模拟
- [ghost-cursor](https://github.com/Xetera/ghost-cursor)
- [humanize](https://github.com/HubSpot/humanize)

## 📝 实施优先级

### P0 (必须完成)
1. WebDriver 隐藏
2. 基础行为随机化
3. 混合控制模式

### P1 (重要)
4. Canvas 指纹伪装
5. OCR 文字识别
6. 反爬虫测试

### P2 (可选)
7. 模板匹配
8. UI 元素识别
9. 完整文档

## 🚀 开始时间
待确认

## ✅ 完成时间
预计 2-3 周
