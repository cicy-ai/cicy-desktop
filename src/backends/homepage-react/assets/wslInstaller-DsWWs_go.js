var e=new Set([`docker-desktop`,`docker-desktop-data`,`docker-desktop-bootstrap`]),t=[`Ubuntu`,`Ubuntu-24.04`,`Ubuntu-22.04`,`Ubuntu-20.04`,`Debian`],n=[`https://ghproxy.net/`,`https://gh-proxy.com/`],r={cn:[`https://mirrors.aliyun.com/ubuntu`,`https://mirrors.tuna.tsinghua.edu.cn/ubuntu`,`http://archive.ubuntu.com/ubuntu`],global:[`http://archive.ubuntu.com/ubuntu`,`https://mirrors.aliyun.com/ubuntu`]},i={shellShort:1e4,shellMed:3e4,shellLong:12e4,download:12e4,wslInstall:15*6e4,wslBoot:9e4};function a(){if(typeof window>`u`||typeof window.electronRPC!=`function`)throw Error(`electronRPC unavailable — open this page inside cicy-desktop's homepage window (v2.1.12+)`)}async function o(e,{timeoutMs:t=i.shellMed}={}){a();let n=await window.electronRPC(`exec_shell`,{command:e,timeout_ms:t}),r=n;if(n&&n.content){let e=(n.content||[]).map(e=>e.text).filter(Boolean).join(``);try{r=JSON.parse(e)}catch{r={ok:!0,stdout:e,stderr:``,exitCode:0}}}return{ok:(r.exitCode||0)===0,stdout:s(r.stdout),stderr:s(r.stderr),code:r.exitCode||0}}function s(e){return String(e||``).replace(/\u0000/g,``).replace(/\r/g,``)}async function c(e,t={}){let n=new Uint16Array(e.length);for(let t=0;t<e.length;t++)n[t]=e.charCodeAt(t);return o(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${btoa(String.fromCharCode(...new Uint8Array(n.buffer)))}`,t)}async function l(e,t,n={}){let r=new TextEncoder().encode(t),i=``;for(let e=0;e<r.length;e++)i+=String.fromCharCode(r[e]);return o(`wsl -d ${e} -- bash -c "echo ${btoa(i)} | base64 -d | bash -l"`,n)}async function u(e,t,n={}){return o(`wsl -d ${e} -e ${t.map(e=>`"${String(e).replace(/"/g,`\\"`)}"`).join(` `)}`,n)}async function d(){let e=await c(`
$ProgressPreference = 'SilentlyContinue'
$result = 'unknown'
# Race: probe google first, baidu second; first reachable wins.
$jobs = @(
  Start-Job -ScriptBlock { try { $r = Invoke-WebRequest 'https://www.google.com/generate_204' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 204) { 'global' } } catch {} },
  Start-Job -ScriptBlock { try { $r = Invoke-WebRequest 'https://www.baidu.com/' -Method Head -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { 'cn' } } catch {} }
)
foreach ($j in $jobs) {
  Wait-Job $j -Timeout 4 | Out-Null
  $out = Receive-Job $j
  if ($out -and $result -eq 'unknown') { $result = $out }
  Remove-Job $j -Force | Out-Null
}
Write-Output $result
`,{timeoutMs:i.shellShort});return e.ok?e.stdout.trim():`unknown`}function f(e){let t=`https://github.com/cicy-ai/cicy-code/releases/latest/download/manifest.json`;return e===`cn`?[...n.map(e=>e+t),t]:[t,...n.map(e=>e+t)]}async function p(e){let t=f(e),n=await c(`
$ProgressPreference = 'SilentlyContinue'
$urls = '${JSON.stringify(t).replace(/'/g,`''`)}' | ConvertFrom-Json
foreach ($u in $urls) {
  try {
    $m = Invoke-RestMethod -Uri $u -UseBasicParsing -TimeoutSec 8
    Write-Output ('OK ' + ($m | ConvertTo-Json -Depth 6 -Compress))
    exit 0
  } catch { continue }
}
Write-Output 'ERR no reachable manifest'
exit 1
`,{timeoutMs:6e4});if(!n.ok||!n.stdout.startsWith(`OK `))return{ok:!1,error:n.stdout||n.stderr||`unreachable`};try{let e=JSON.parse(n.stdout.slice(3));return!e.version||!e.assets?{ok:!1,error:`manifest malformed`}:{ok:!0,version:e.version,assets:e.assets}}catch(e){return{ok:!1,error:`json parse: `+e.message}}}async function m({assetUrl:e,network:t,dstPath:r,expectMin:a=1e6}){let o=t===`cn`?[...n.map(t=>t+e),e]:[e,...n.map(t=>t+e)],s=await c(`
$ProgressPreference = 'SilentlyContinue'
$urls = '${JSON.stringify(o).replace(/'/g,`''`)}' | ConvertFrom-Json
$jobs = @()
foreach ($u in $urls) {
  $jobs += Start-Job -ScriptBlock {
    param($url)
    try {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 5
      $sw.Stop()
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) {
        Write-Output ("OK $($sw.ElapsedMilliseconds) $url")
      }
    } catch {}
  } -ArgumentList $u
}
Wait-Job $jobs -Timeout 7 | Out-Null
$results = @()
foreach ($j in $jobs) { $r = Receive-Job $j; if ($r) { $results += $r }; Remove-Job $j -Force | Out-Null }
$results | Sort-Object { [int]($_.Split(' ')[1]) }
`,{timeoutMs:12e3}),l=o;if(s.ok&&s.stdout){let e=s.stdout.split(`
`).map(e=>e.trim()).filter(e=>e.startsWith(`OK `)).map(e=>e.split(` `).slice(2).join(` `)).filter(Boolean);e.length&&(l=[...e,...o.filter(t=>!e.includes(t))])}for(let e=0;e<l.length;e++){let t=l[e],n=await c(`
$ProgressPreference = 'SilentlyContinue'
$dst = '${r.replace(/'/g,`''`)}'
$url = '${t.replace(/'/g,`''`)}'
New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
try {
  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -TimeoutSec 120
  $size = (Get-Item $dst).Length
  Write-Output "OK $size"
} catch {
  Write-Output "FAIL $($_.Exception.Message)"
  exit 1
}
`,{timeoutMs:i.download});if(n.ok&&n.stdout.startsWith(`OK `)){let e=parseInt(n.stdout.match(/OK (\d+)/)?.[1]||`0`,10);if(e<a)continue;return{ok:!0,size:e,url:t}}}return{ok:!1,error:`all mirrors failed`}}async function h(){let e=await o(`wsl --status`,{timeoutMs:8e3});if(!e.ok)return{installed:!1,supported:!0};let t=e.stdout.match(/Default Version:\s*(\d)/i),n=t?parseInt(t[1],10):2,r=await o(`wsl -l -v`,{timeoutMs:8e3});if(!r.ok||!r.stdout.trim())return{installed:!0,supported:!0,hasDistro:!1,defaultVer:n};let i=[],a=null;for(let e of r.stdout.split(/\r?\n/)){let t=e.trimStart().startsWith(`*`),n=e.replace(/^\s*\*?\s*/,``).trim();if(!n||/^NAME\b/i.test(n))continue;let r=n.split(/\s+/);if(r.length<3)continue;let[o,s,c]=r;i.push({name:o,state:s,version:parseInt(c,10)||1}),t&&(a=o)}let s=g(i);return{installed:!0,supported:!0,hasDistro:s!==null,distros:i,defaultDistro:a,usableDistro:s,defaultVer:n}}function g(n){for(let e of t){let t=n.find(t=>t.name.toLowerCase()===e.toLowerCase());if(t)return t.name}for(let t of n)if(!e.has(t.name.toLowerCase()))return t.name;return null}async function _(e,t){t({phase:`installing-wsl`,message:`Installing WSL2 + Ubuntu (5–10 min, requires admin)…`});let n=e===`cn`||e===`unknown`,r=await o(`wsl --install ${n?`--web-download`:``} --no-launch -d Ubuntu`,{timeoutMs:i.wslInstall});if(r.ok||n&&(t({phase:`installing-wsl`,message:`Web download failed, retrying via Microsoft Store…`}),(await o(`wsl --install --no-launch -d Ubuntu`,{timeoutMs:i.wslInstall})).ok))return{ok:!0};t({phase:`installing-wsl`,message:`Falling back to direct rootfs import…`});let a=await v(e,t);return a.ok?{ok:!0,method:`rootfs-import`}:{ok:!1,error:r.stderr||a.error||`wsl --install exit ${r.code}`}}async function v(e,t){let n=(e===`cn`?[`https://mirror.nju.edu.cn/ubuntu-cloud-images/wsl/jammy/current`,`https://mirrors.ustc.edu.cn/ubuntu-cloud-images/wsl/jammy/current`,`https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current`,`https://cloud-images.ubuntu.com/wsl/jammy/current`]:[`https://cloud-images.ubuntu.com/wsl/jammy/current`,`https://mirror.nju.edu.cn/ubuntu-cloud-images/wsl/jammy/current`,`https://mirrors.ustc.edu.cn/ubuntu-cloud-images/wsl/jammy/current`]).map(e=>`${e}/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz`);t({phase:`installing-wsl`,message:`Picking fastest Ubuntu rootfs mirror…`});let r=await c(`
$ProgressPreference = 'SilentlyContinue'
$urls = '${JSON.stringify(n).replace(/'/g,`''`)}' | ConvertFrom-Json
$jobs = @()
foreach ($u in $urls) {
  $jobs += Start-Job -ScriptBlock {
    param($url)
    try {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 5
      $sw.Stop()
      if ($r.StatusCode -ge 200) { Write-Output ("OK $($sw.ElapsedMilliseconds) $url") }
    } catch {}
  } -ArgumentList $u
}
Wait-Job $jobs -Timeout 7 | Out-Null
$res = @()
foreach ($j in $jobs) { $r = Receive-Job $j; if ($r) { $res += $r }; Remove-Job $j -Force | Out-Null }
$res | Sort-Object { [int]($_.Split(' ')[1]) }
`,{timeoutMs:12e3}),i=n;if(r.ok&&r.stdout){let e=r.stdout.split(`
`).map(e=>e.trim()).filter(e=>e.startsWith(`OK `)).map(e=>e.split(` `).slice(2).join(` `)).filter(Boolean);e.length&&(i=[...e,...n.filter(t=>!e.includes(t))])}t({phase:`installing-wsl`,message:`Downloading Ubuntu rootfs (~350MB, may take a few minutes)…`});let a=await c(`
$ProgressPreference = 'SilentlyContinue'
$tar = Join-Path $env:TEMP 'ubuntu-jammy-wsl.tar.gz'
$dst = Join-Path $env:LOCALAPPDATA 'WSL\\Ubuntu'
New-Item -ItemType Directory -Force $dst | Out-Null
$urls = '${JSON.stringify(i).replace(/'/g,`''`)}' | ConvertFrom-Json
$ok = $false
foreach ($u in $urls) {
  try {
    Invoke-WebRequest -Uri $u -OutFile $tar -UseBasicParsing -TimeoutSec 1800
    if ((Get-Item $tar).Length -gt 50000000) { $ok = $true; Write-Output ("DOWNLOADED " + $u); break }
  } catch { Write-Output ("FAIL " + $u + " " + $_.Exception.Message) }
}
if (-not $ok) { Write-Output "ERR no mirror"; exit 1 }
& wsl --import Ubuntu $dst $tar --version 2
if ($LASTEXITCODE -ne 0) { Write-Output ("IMPORT_FAIL " + $LASTEXITCODE); exit 1 }
Remove-Item -Force $tar -ErrorAction SilentlyContinue
Write-Output "IMPORTED"
`,{timeoutMs:35*6e4});return!a.ok||!/IMPORTED/.test(a.stdout)?{ok:!1,error:a.stderr||a.stdout||`rootfs-import failed`}:{ok:!0,method:`rootfs-import`}}async function y(e,t,n=i.wslBoot){let r=Date.now();for(;Date.now()-r<n;){if((await u(e,[`true`],{timeoutMs:1e4})).ok)return{ok:!0};t({phase:`waiting-distro`,message:`Waiting for ${e} to boot…`}),await new Promise(e=>setTimeout(e,3e3))}return{ok:!1,error:`${e} did not boot in ${Math.round(n/1e3)}s`}}async function b(e,t,n){n({phase:`configuring-apt`,message:`Probing apt mirror reachability…`});let i=await l(e,`set -e
. /etc/os-release
echo "CODENAME=$VERSION_CODENAME"
if [ -s /etc/apt/sources.list ]; then
  echo "FILE=/etc/apt/sources.list"
elif [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
  echo "FILE=/etc/apt/sources.list.d/ubuntu.sources"
else
  echo "FILE=/etc/apt/sources.list"
fi
CUR=$(grep -m1 -oE 'https?://[^ /]+' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null | head -1 | sed 's/.*: *//') || true
echo "CUR=$CUR"
if [ -n "$CUR" ] && curl -fsI --max-time 5 "$CUR" >/dev/null 2>&1; then
  echo "REACHABLE=1"
else
  echo "REACHABLE=0"
fi`,{timeoutMs:25e3});if(!i.ok)return{ok:!1,error:`probe failed: `+i.stderr};let a=Object.fromEntries(i.stdout.split(`
`).map(e=>{let t=e.indexOf(`=`);return t<0?[e,``]:[e.slice(0,t),e.slice(t+1)]}));if(a.REACHABLE===`1`)return n({phase:`configuring-apt`,message:`apt mirror reachable: ${a.CUR}`}),{ok:!0,mirror:a.CUR,changed:!1};let o=await l(e,(r[t]||r.global).map(e=>`if curl -fsI --max-time 5 "${e}/dists/${a.CODENAME}/Release" >/dev/null 2>&1; then echo "${e}"; exit 0; fi`).join(`
`)+`
exit 1`,{timeoutMs:35e3});if(!o.ok||!o.stdout)return{ok:!1,error:`no reachable apt mirror`};let s=o.stdout.trim().split(/\r?\n/).pop(),c=a.CODENAME||`jammy`,u=await l(e,`set -e
CONTENT='${[`deb ${s} ${c} main restricted universe multiverse`,`deb ${s} ${c}-updates main restricted universe multiverse`,`deb ${s} ${c}-backports main restricted universe multiverse`,`deb ${s} ${c}-security main restricted universe multiverse`].join(`
`).replace(/'/g,`'\\''`)}'
write_file() {
  local f=$1
  if [ -w "$f" ] || [ ! -e "$f" ]; then echo "$CONTENT" > "$f";
  elif command -v sudo >/dev/null 2>&1; then echo "$CONTENT" | sudo tee "$f" >/dev/null;
  else return 1; fi
}
# Disable any existing deb822 sources (Noble+) so our deb-style takes effect.
if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
  if [ -w /etc/apt/sources.list.d/ubuntu.sources ]; then
    mv /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak 2>/dev/null
  elif command -v sudo >/dev/null 2>&1; then
    sudo mv /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak 2>/dev/null
  fi
fi
write_file /etc/apt/sources.list || { echo "no-write-access" >&2; exit 1; }
echo "MIRROR=${s}"`,{timeoutMs:1e4});return u.ok?(n({phase:`configuring-apt`,message:`apt mirror switched to ${s}`}),{ok:!0,mirror:s,changed:!0}):{ok:!1,error:u.stderr||`write failed`}}async function x(e,t,n,r){r({phase:`installing-cicy-code`,message:`Installing cicy-code v${n} into ${e}…`,version:n});let i=await o(`wsl -d ${e} -e wslpath -a "${t.replace(/\\/g,`\\\\`)}"`,{timeoutMs:1e4});if(!i.ok)return{ok:!1,error:`wslpath failed: `+i.stderr};let a=await l(e,`set -eu
mkdir -p $HOME/.local/bin
cp '${i.stdout.trim().replace(/'/g,`'\\''`)}' $HOME/.local/bin/cicy-code.new
chmod +x $HOME/.local/bin/cicy-code.new
mv -f $HOME/.local/bin/cicy-code.new $HOME/.local/bin/cicy-code
ACT=$($HOME/.local/bin/cicy-code --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || echo unknown)
printf '%s' "$ACT" > $HOME/.local/bin/cicy-code.version
echo "INSTALLED:$ACT"`,{timeoutMs:6e4});if(!a.ok)return{ok:!1,error:a.stderr||`install failed`};let s=a.stdout.match(/INSTALLED:([0-9.]+)/);return{ok:!0,version:s?s[1]:n}}async function S(){let e=await c(`
$dir = Join-Path $env:APPDATA 'CiCy Desktop\\cicy-code\\wsl-stage'
New-Item -ItemType Directory -Force $dir | Out-Null
Write-Output (Join-Path $dir 'cicy-code-staged')
`,{timeoutMs:5e3});if(!e.ok)throw Error(`stage path resolution failed`);return e.stdout.trim()}async function C(e){await c(`Remove-Item -Force '${e.replace(/'/g,`''`)}' -ErrorAction SilentlyContinue`,{timeoutMs:5e3})}async function w({onProgress:e=()=>{}}={}){let t=t=>{try{e(t)}catch{}};a(),t({phase:`detecting`,message:`Checking Docker…`});let n=await o(`docker version --format "{{.Server.Version}}"`,{timeoutMs:8e3});if(n.ok&&n.stdout.trim()){t({phase:`downloading`,message:`Pulling cicybot/cicy-code via Docker…`});let e=await o(`docker pull dockerproxy.com/cicybot/cicy-code:latest`,{timeoutMs:3e5});if(!e.ok)throw Error(`docker pull failed: `+(e.stderr||e.stdout).slice(0,200));await o(`docker rm -f cicy-code`,{timeoutMs:1e4});let n=await o(`docker run -d --name cicy-code --restart unless-stopped -p 8008:8008 dockerproxy.com/cicybot/cicy-code:latest --public --agents=claude,codex,opencode`,3e4);if(!n.ok)throw Error(`docker run failed: `+(n.stderr||n.stdout).slice(0,200));let r=await o(`docker exec cicy-code cicy-code --version`,{timeoutMs:1e4}),i=r.stdout&&r.stdout.match(/(\d+\.\d+\.\d+)/),a=i?i[1]:`latest`;return t({phase:`done`,message:`cicy-code v${a} running via Docker`,version:a}),{ok:!0,version:a}}t({phase:`detecting`,message:`Detecting network…`});let r=await d();t({phase:`detecting`,message:`Network: ${r}`,network:r}),t({phase:`checking`,message:`Checking latest version…`});let i=await p(r);if(!i.ok)throw Error(`manifest fetch failed: `+i.error);let s=i.version,c=i.assets[`linux-amd64`];if(!c)throw Error(`manifest has no linux-amd64 asset`);t({phase:`checking`,message:`Latest: v${s}`,version:s,network:r});let l=await S();t({phase:`downloading`,message:`Downloading cicy-code v${s}…`,version:s,network:r});let u=await m({assetUrl:c,network:r,dstPath:l});if(!u.ok)throw Error(`download failed: `+u.error);t({phase:`downloading`,message:`Downloaded ${(u.size/1024/1024).toFixed(1)} MB`,progress:1,version:s});try{t({phase:`checking-wsl`,message:`Checking WSL state…`});let e=await h();if(!e.installed||!e.usableDistro){let n=await _(r,t);if(!n.ok)throw Error(`wsl install: `+n.error);if(e=await h(),!e.usableDistro)throw Error(`WSL installed but no usable distro detected — Windows may need a reboot`);let i=await y(e.usableDistro,t);if(!i.ok)throw Error(i.error)}let n=e.usableDistro;t({phase:`checking-wsl`,message:`Using distro: ${n}`});let i=await b(n,r,t);i.ok||t({phase:`configuring-apt`,message:`Warning: apt mirror config failed (${i.error}), continuing`});let a=await x(n,l,s,t);if(!a.ok)throw Error(`install: `+a.error);return t({phase:`done`,message:`Installed v${a.version}`,version:a.version}),{ok:!0,version:a.version}}finally{C(l).catch(()=>{})}}function T(){return typeof window<`u`&&typeof window.electronRPC==`function`}export{T as canRunRendererInstall,w as windowsInstall};