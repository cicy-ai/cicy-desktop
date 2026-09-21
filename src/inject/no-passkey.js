// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// document-start 注入:让页面认为这台机器没有可用的通行密钥验证器。
//
// 为什么需要:accounts.meta.com 这类站点一进登录页就调 navigator.credentials.get({publicKey}),
// Windows 随即弹出「使用密钥登录 · 请将安全密钥插入 USB 端口」这个**系统模态框**。机器上
// 根本没有安全密钥,框又是系统级的、页面脚本关不掉,矩阵里正在跑的自动登录就卡死在那儿。
//
// 为什么不用 --disable-features=WebAuthentication:那个 feature 名在现在的 Chromium 里
// 已经不存在了,开关传得进去但完全不起作用(2026-09-21 在 2.1.362 上实测,PublicKeyCredential
// 照样是 function)。
//
// 为什么不直接 delete PublicKeyCredential:整个对象拿掉会让 Facebook 的两步验证页渲染不出来
// (Comet 挂载了但树是空的,实测白板)。所以对象保留,只回答「没有验证器」,并让 passkey 请求
// 以标准的 NotAllowedError(等同用户取消)拒绝 —— 站点对这个错误都有正常的密码回退路径。
(function () {
  try {
    if (window.PublicKeyCredential) {
      const no = () => Promise.resolve(false);
      try { PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = no; } catch (e) {}
      try { PublicKeyCredential.isConditionalMediationAvailable = no; } catch (e) {}
      try {
        if (PublicKeyCredential.getClientCapabilities) {
          PublicKeyCredential.getClientCapabilities = () => Promise.resolve({});
        }
      } catch (e) {}
    }
    if (navigator.credentials) {
      const get = navigator.credentials.get.bind(navigator.credentials);
      const create = navigator.credentials.create ? navigator.credentials.create.bind(navigator.credentials) : null;
      const deny = () => Promise.reject(
        new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      // 只挡 publicKey(通行密钥);密码管理器那套 credentials 不受影响。
      navigator.credentials.get = (o) => (o && o.publicKey ? deny() : get(o));
      if (create) navigator.credentials.create = (o) => (o && o.publicKey ? deny() : create(o));
    }
  } catch (e) { /* 注入失败不能影响页面 */ }
})();
