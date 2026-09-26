# 研究摘要 — the-loki/mono-space#3（Fab 资产 key 激活）
- **结论**：Fab 没有官方公开兑换 API；Humble 引擎资产包以**兑换码**交付，官方唯一入口是 `https://www.epicgames.com/account/code-redemption`（302 → `accounts.epicgames.com`，Epic 账号 OAuth 授权码流程，两步 Redeem → Confirm）。
- `fab.com/redeem`、`/account/code-redemption` 等**稳定 404**；Fab 内部 `https://www.fab.com/i/...` 是 cookie + `X-CsrfToken` 鉴权的 JSON API，**无 redeem 端点**，且全站在 Cloudflare managed challenge + hCaptcha（`fab_csrftoken` / `__cf_bm`）。
- **边界**：登录、2FA、Cloudflare/hCaptcha 必须由真实浏览器（人/内嵌 Chromium）完成；「填码 → Redeem → Confirm → 回 My Library 校验 entitlement」可自动化。无可借用的客户端票据。
- **Linux 专属（官方原文）**：「Fab in Launcher is only available on Windows and Mac.」安装包只有 `.msi`/`.dmg`（`.deb`/`.rpm` → 404），Linux 只能走浏览器 fab.com + UE 5.3+ 的 Fab 插件。
- **回执**：成功 = 商品进入 Fab My Library（Epic 官方文档 + Humble 文章）；UE/UEFN 格式需 Launcher/插件才进工程（官方明示的「需额外步骤」）。
- **旧 UE Marketplace 码**：新旧文档指向**同一个兑换页 URL**；已购资产在 Launcher 的 Fab Library（旧称 Vault）可见，许可证沿用 UE Marketplace License。
- **剔除**：Steam / GOG / EA App / Ubisoft Connect / Battle.net 兑换的是游戏本体 license，与开发资产无关（Steam 已有接口的一手证据仅存档备查）。
- 附录路标：Unity Asset Store（voucher → `id.unity.com/en/redeem_products/new` + assign seats）、Blender Market（coupon → checkout）、itch.io（key link claim）、CGTrade/GameMaker 未验证。
- **未验证 / 开放问题共 10 项**（最关键：Epic 兑换错误码/文案枚举、Fab「Redeem Code」菜单实际 href、Epic 兑换限速阈值与封控条件）；完整证据含每条来源 URL 与复现命令见 `docs/research/store-redemption.md` @ `e9c64f5`。
