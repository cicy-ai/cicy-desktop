; electron-builder 安装脚本钩子(会被自动 include)。
;
; 背景:静默安装(/S,舰队自更新和一键 bat 都走静默)下,electron-builder
; 默认的 runAfterFinish 不会触发 —— 于是"装完 App 没起来",而看门狗计划任务
; (CiCyDesktopWatchdog)是 App 运行时才注册的,App 没起来就没人拉它,机器一直
; 躺尸,只能人工 RustDesk 逐台救(见 2026-09-04 全舰队升级事故)。
;
; 修法:安装完成(含静默)后,由安装器显式把 App 拉起来。App 启动时的
; ensureWindowsWatchdog 会自行(重新)注册看门狗任务,自愈链路即恢复:
;   安装器启动 App → App 注册看门狗 → 之后 App 崩溃/退出,看门狗 1 分钟内拉回。
; 保持最小(单行 Exec),不在 NSIS 里内联复杂 PowerShell,避免弄坏安装器。

!macro customInstall
  ; --hidden:后台/托盘启动,不抢焦点、不弹主窗
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
!macroend
