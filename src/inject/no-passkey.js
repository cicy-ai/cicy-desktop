// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// document-start 注入:让页面认为这台机器没有可用的通行密钥验证器,从而不弹
// Windows 的「请将安全密钥插入 USB 端口」系统模态框(会卡死矩阵里的自动登录)。
//
// 关键:必须改**主世界**的 navigator.credentials / PublicKeyCredential。
// 这个文件既作普通窗口的 session 预加载,也作 <webview> 客机的 preload,两种场景
// 大多 contextIsolation=true —— 预加载跑在隔离世界,直接改 navigator 改的是隔离世界的副本,
// 页面(主世界)根本不受影响(实测 2.1.364:webview 里 credentials.get 仍是原生,照弹框)。
// 所以统一走「往文档里插一个 <script> 让补丁在主世界执行」,隔离/主世界都能生效,
// 且 document-start 时插入 = 先于页面脚本。
(function () {
  const patch = function () {
    try {
      if (window.PublicKeyCredential) {
        const no = function () { return Promise.resolve(false); };
        try { PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = no; } catch (e) {}
        try { PublicKeyCredential.isConditionalMediationAvailable = no; } catch (e) {}
        try { if (PublicKeyCredential.getClientCapabilities) PublicKeyCredential.getClientCapabilities = function () { return Promise.resolve({}); }; } catch (e) {}
      }
      if (navigator.credentials) {
        const get = navigator.credentials.get ? navigator.credentials.get.bind(navigator.credentials) : null;
        const create = navigator.credentials.create ? navigator.credentials.create.bind(navigator.credentials) : null;
        const deny = function () { return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError")); };
        if (get) navigator.credentials.get = function (o) { return (o && o.publicKey) ? deny() : get(o); };
        if (create) navigator.credentials.create = function (o) { return (o && o.publicKey) ? deny() : create(o); };
      }
    } catch (e) { /* 不能影响页面 */ }
  };
  try {
    // 主世界执行:把补丁函数体塞进一个 <script>,插到 documentElement 上同步运行,随即移除。
    const el = document.createElement("script");
    el.textContent = "(" + patch.toString() + ")();";
    (document.documentElement || document.head || document).appendChild(el);
    el.remove();
  } catch (e) {
    // 万一 DOM 还没有(极早期),退回直接在当前世界打一遍(contextIsolation=false 时这就够了)
    try { patch(); } catch (e2) {}
  }
})();
