// 构建前给每个 panel 页面打内容版本号:pv = sha256(剔除pv值后的html) 前12位。
// 内容不变则版本不变(不会无谓触发前端 reload);内容一变,pv 变,前端轮询到就自动更新。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = path.join(import.meta.dirname, 'public', 'panel');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  const p = path.join(dir, f);
  let html = fs.readFileSync(p, 'utf8');
  if (!/<meta name="pv" content="[^"]*">/.test(html)) continue; // 该页没接入自动更新,跳过
  const stripped = html.replace(/<meta name="pv" content="[^"]*">/, '<meta name="pv" content="">');
  const ver = crypto.createHash('sha256').update(stripped).digest('hex').slice(0, 12);
  html = stripped.replace('<meta name="pv" content="">', `<meta name="pv" content="${ver}">`);
  fs.writeFileSync(p, html);
  console.log(`  pv ${f} = ${ver}`);
}
