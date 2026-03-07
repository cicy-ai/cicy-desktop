const { BrowserWindow } = require("electron");
const { z } = require("zod");

function registerTools(registerTool) {
  registerTool(
    "exec_js",
    "在窗口中执行JS代码并返回结果,支持async/await。示例: document.title 或 return document.title 或 await fetch('/api').then(r=>r.json())",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      code: z.string().describe("JS 代码"),
    }),
    async ({ win_id, code }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        // 简化代码包装逻辑
        let wrappedCode = code.trim();

        // 如果代码不包含 return 且不是多语句，自动添加 return
        if (
          !wrappedCode.includes("return") &&
          !wrappedCode.includes(";") &&
          !wrappedCode.includes("\n")
        ) {
          wrappedCode = `return ${wrappedCode}`;
        }

        // 包装为异步函数
        wrappedCode = `(async () => { ${wrappedCode} })()`;

        const result = await win.webContents.executeJavaScript(wrappedCode);
        const text =
          result !== null && typeof result === "object"
            ? JSON.stringify(result, null, 2)
            : String(result);
        return {
          content: [
            { type: "text", text },
            { type: "text", text: `>> exec_js ok` },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "JavaScript" }
  );

  registerTool(
    "get_element_client_bound",
    "获取页面元素的位置和尺寸信息(getBoundingClientRect)。返回元素的 x, y, width, height, top, left, right, bottom 坐标。selector 必须唯一且不能为空",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      selector: z
        .string()
        .min(1, "CSS选择器不能为空")
        .describe("CSS 选择器，如 '#id', '.class', 'button'"),
    }),
    async ({ win_id, selector }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const escapedSelector = selector.replace(/'/g, "\\'");
        const result = await win.webContents.executeJavaScript(`
          (function() {
            const selector = '${escapedSelector}';

            if (!selector || selector.trim() === '') {
              return { error: 'CSS选择器不能为空' };
            }

            const allElements = document.querySelectorAll(selector);
            if (allElements.length === 0) {
              return { error: '未找到匹配的元素: ' + selector };
            }
            if (allElements.length > 1) {
              return { error: '选择器匹配多个元素，请使用唯一选择器，匹配数量: ' + allElements.length };
            }

            const el = allElements[0];
            const rect = el.getBoundingClientRect();
            return {
              selector: selector,
              count: allElements.length,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom)
            };
          })()
        `);

        if (result.error) {
          return { content: [{ type: "text", text: result.error }], isError: true };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "JavaScript" }
  );

  registerTool(
    "show_float_div",
    "在页面中心显示一个可拖拽、可调整大小的浮动 div。支持自定义位置、尺寸和透明度。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      x: z.number().optional().describe("X 坐标 (默认居中)"),
      y: z.number().optional().describe("Y 坐标 (默认居中)"),
      w: z.number().optional().default(300).describe("宽度 (默认 300)"),
      h: z.number().optional().default(200).describe("高度 (默认 200)"),
      opacity: z.number().optional().default(0.7).describe("背景透明度 0-1 (默认 0.7)"),
    }),
    async ({ win_id, x, y, w, h, opacity }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const jsCode = `(function() {
            try {
            var existDiv = document.getElementById('__float_div__');
            if (existDiv) { existDiv.remove(); }
            
            var div = document.createElement('div');
            div.id = '__float_div__';
            
            var viewportW = window.innerWidth;
            var viewportH = window.innerHeight;
            var initW = ${w} || 300;
            var initH = ${h} || 200;
            var initX = ${x} || Math.round((viewportW - initW) / 2);
            var initY = ${y} || Math.round((viewportH - initH) / 2);
            var opacity = ${opacity} || 0.7;
            
            div.style.cssText = 'position:fixed;left:' + initX + 'px;top:' + initY + 'px;width:' + initW + 'px;height:' + initH + 'px;background:rgba(255,0,0,' + opacity + ');color:#fff;z-index:999999;border:2px solid #fff;';
            
            // 左上角坐标
            var tl = document.createElement('div');
            tl.textContent = initX + ',' + initY;
            tl.style.cssText = 'position:absolute;top:4px;left:4px;font-family:monospace;font-size:14px;font-weight:bold;color:#fff;';
            div.appendChild(tl);
            
            // 右上角坐标
            var tr = document.createElement('div');
            tr.textContent = (initX + initW) + ',' + initY;
            tr.style.cssText = 'position:absolute;top:4px;right:4px;font-family:monospace;font-size:14px;font-weight:bold;color:#fff;';
            div.appendChild(tr);
            
            // 左下角坐标
            var bl = document.createElement('div');
            bl.textContent = initX + ',' + (initY + initH);
            bl.style.cssText = 'position:absolute;bottom:4px;left:4px;font-family:monospace;font-size:14px;font-weight:bold;color:#fff;';
            div.appendChild(bl);
            
            // 右下角坐标
            var br = document.createElement('div');
            br.textContent = (initX + initW) + ',' + (initY + initH);
            br.style.cssText = 'position:absolute;bottom:4px;right:4px;font-family:monospace;font-size:14px;font-weight:bold;color:#fff;';
            div.appendChild(br);
            
            // 关闭按钮
            var closeBtn = document.createElement('div');
            closeBtn.textContent = 'X';
            closeBtn.style.cssText = 'position:absolute;top:50%;right:4px;transform:translateY(-50%);width:16px;height:16px;cursor:pointer;font-size:12px;font-weight:bold;background:#fff;color:#f00;text-align:center;line-height:16px;';
            closeBtn.onclick = function(e) { e.stopPropagation(); div.remove(); };
            div.appendChild(closeBtn);
            
            // resize 把手
            var resizeHandle = document.createElement('div');
            resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;background:#fff;cursor:se-resize;';
            div.appendChild(resizeHandle);
            
            var dragX = initX, dragY = initY, curW = initW, curH = initH;
            var isDrag = false, isResize = false, startX, startY;
            
            div.addEventListener('mousedown', function(e) {
              if (e.target === closeBtn || e.target === resizeHandle) return;
              isDrag = true;
              startX = e.clientX;
              startY = e.clientY;
              e.preventDefault();
              e.stopPropagation();
            });
            
            resizeHandle.addEventListener('mousedown', function(e) {
              isResize = true;
              startX = e.clientX;
              startY = e.clientY;
              e.preventDefault();
              e.stopPropagation();
            });
            
            document.addEventListener('mousemove', function(e) {
              if (isDrag) {
                dragX += e.clientX - startX;
                dragY += e.clientY - startY;
                div.style.left = dragX + 'px';
                div.style.top = dragY + 'px';
                startX = e.clientX;
                startY = e.clientY;
                tl.textContent = Math.round(dragX) + ',' + Math.round(dragY);
                tr.textContent = Math.round(dragX + curW) + ',' + Math.round(dragY);
                bl.textContent = Math.round(dragX) + ',' + Math.round(dragY + curH);
                br.textContent = Math.round(dragX + curW) + ',' + Math.round(dragY + curH);
              } else if (isResize) {
                curW = Math.max(100, curW + e.clientX - startX);
                curH = Math.max(60, curH + e.clientY - startY);
                div.style.width = curW + 'px';
                div.style.height = curH + 'px';
                startX = e.clientX;
                startY = e.clientY;
                tr.textContent = Math.round(dragX + curW) + ',' + Math.round(dragY);
                bl.textContent = Math.round(dragX) + ',' + Math.round(dragY + curH);
                br.textContent = Math.round(dragX + curW) + ',' + Math.round(dragY + curH);
              }
            });
            
            document.addEventListener('mouseup', function() {
              isDrag = false;
              isResize = false;
            });
            
            document.body.appendChild(div);
            return 'OK: div at ' + Math.round(initX) + ',' + Math.round(initY) + ' size ' + initW + 'x' + initH;
            } catch(e) { return 'ERROR: ' + e.message; }
          })()`;

        const result = await win.webContents.debugger.sendCommand("Runtime.evaluate", {
          expression: jsCode,
        });
        console.log("[show_float_div] result:", result);

        return {
          content: [
            {
              type: "text",
              text: result.result?.value || result.result?.description || JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "JavaScript" }
  );
}

module.exports = registerTools;
