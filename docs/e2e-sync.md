# E2E 跨端同步 · 服务端零明文

> 目标(三条):①运营后台**只看用户活跃**;②服务端**不存任何敏感明文**;③用户数据**跨端同步**(desktop / mobile / 未来 web)。
> 结论:活跃走非敏感心跳;敏感数据(团队 `host_url`、内嵌 `?token=`、api_token 等)**客户端加密 → 服务端只存密文 → 各设备本地解密**。

## 0. 边界:什么加密、什么不加密

| 数据 | 敏感? | 存法 |
|---|---|---|
| deviceId + last_seen(活跃心跳) | 否 | 服务端**明文**(POST /api/device/register 已做) |
| 账号 tier / plan | 否 | 服务端明文 |
| 团队 `host_url`(含 `?token=`)、api_token、团队名等用户数据 | **是** | 客户端 E2E 加密,服务端**只存密文 + 盲索引** |

前提成立的原因:服务端**不需要** host_url 明文(不代理、不解析,只当同步 blob + 去重键)。

## 1. 密码学原语(三端统一 libsodium)

desktop=Node(`sodium-native`/`libsodium-wrappers`)、mobile=RN(`react-native-libsodium`/expo)、cloud 只转发不解密(如需校验有 Go 版)。原语一一对应:

| 用途 | libsodium |
|---|---|
| 数据加密 | `crypto_aead_xchacha20poly1305_ietf`(AEK + 随机 24B nonce) |
| 盲索引(去重/查找,不泄原文) | `crypto_generichash`(BLAKE2b keyed,key=HKDF(AEK,"idx")) |
| 给某设备包 AEK | `crypto_box_seal`(匿名密封盒,只需对方公钥) |
| 设备密钥对 | `crypto_box_keypair`(X25519) |
| 口令找回(纯单设备兜底) | `crypto_pwhash`(Argon2id) |

## 2. 密钥体系

- **AEK**:账号级随机 256bit 数据密钥,**永不明文上云**。所有敏感数据用它加密。
- **设备密钥对**:每台设备一对 X25519,**公钥**注册到云端(公钥不敏感);私钥进安全区(desktop=OS keychain;mobile=expo-secure-store;**禁明文存**)。
- **wrappedAEK**:AEK 用**每台设备公钥各密封一份**存云端(云端解不开)。
- **口令找回(可选但纯 mobile 用户必需)**:`wrappedAEK_pw = aead(Argon2id(口令,salt), AEK)`,存云端。

### 谁先谁后都行(first-device)
任一端都可能是"第一台":它生成 AEK + 给自己密封一份。之后新设备上线 → 注册公钥 → **一台在线老设备**把 AEK 密封给新设备公钥,云端转发。**不能假设 desktop 先**。
纯 mobile 用户(永远只一台)没有第二设备互包 → **口令找回是必需**,否则换机=数据全丢。

## 3. 同步流程

**写(加/改团队):**
1. `enc = aead(AEK, nonce, JSON{host_url, name, ...})`
2. `idx = blake2b_keyed(idxKey, normalize(host_url))`
3. `POST /api/teams { kind, host_url_enc: {n,ct}, host_url_idx: idx }`(**不再发 host_url 明文**)
4. 云端按 `owner + host_url_idx` get-or-create(去重),存密文。

**读(拉团队):**
1. `GET /api/teams` → 每条 `{host_url_enc, host_url_idx, ...}`
2. 客户端 `aead_open(AEK, enc)` → 明文 URL/字段;解不开(AEK 还没拿到)→ 显示"待解锁"。

**新设备上线(拿 AEK):**
1. 生成密钥对,`POST /api/device/register { …, pubkey }`
2. 轮询/推送:云端有给我的 `wrappedAEK`? 有 → `box_seal_open(privkey, wrappedAEK)` → AEK。
3. 没有 → 提示"在另一台已登录设备上批准此设备" → 老设备 `box_seal(newPub, AEK)` → `POST /api/device/grant`;或走口令找回。

## 4. 迁移
- 云端历史 `host_url` 明文:客户端下次同步补发 `host_url_enc + idx`,服务端回填后**删明文列 / 清历史明文**。
- 过渡期:两端字段并存,客户端优先读 enc,回落明文;全部设备升级后云端下线明文。

## 5. 必然代价(E2E 固有)
- 云端**看不到也搜不到** URL(运营后台不能展示 URL —— 但活跃、tier 等非敏感照常)。
- AEK 全丢(所有设备 + 无口令)= 同步数据不可恢复。
- 新设备无老设备在线时,靠口令找回。

## 6. 三端分工
- **cicy-desktop**:libsodium 加解密 + 盲索引 + seal/unseal;私钥 OS keychain;registerCustomTeam 改发 enc+idx、GET 后解密;first-device/grant 逻辑。
- **cicy-mobile(w-10036)**:同一套 libsodium;私钥 expo-secure-store;grant/口令找回;确认 custom 团队本地化不外泄。
- **cicy-cloud(w-10122)**:schema `host_url → host_url_enc + host_url_idx`;按 idx 去重;device 表加 `pubkey`;存/转发 `wrappedAEK`(register/grant/找回);**服务端零明文使用**;清历史 host_url 明文。心跳活跃保持。
