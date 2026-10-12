# 兼容性与已知限制

| 项目 | v0.1.0 范围 |
| --- | --- |
| DSH | 固定 `0.2.0-rc.2`，其他版本未验证 |
| 开发 / Relay Node | Node.js 24.x；pnpm 11.25.0 |
| Host 当前文件 | 经验证的 macOS/Linux 原版 local / sandbox-local provider |
| Windows 当前文件 | 不支持，拒绝读取；其他能力未做 Windows 验收 |
| SSH / 虚拟 / 自定义 provider | 当前文件读取不支持，不映射成本地路径 |
| 浏览器 | 需要 HTTPS、WebSocket、Web Crypto、Service Worker；Chromium / WebKit 隔离测试 |
| 手机 | 360/390px 模拟视口；真实设备与蜂窝网络不属于已完成验证 |
| 单文件 | 最大 32 MiB；范围读取受限，并校验同一文件版本 |
| 控制端 | 每设备一个有效浏览器控制端，新页面接替旧页面 |

可预览文本、代码、Markdown、图片、PDF、CSV/XLSX、静态 HTML/SVG。Office 转换未接入；不可预览时下载原文件。HTML 脚本及外部依赖不执行/不拉取，Markdown 外部图片受严格 CSP 限制。

文件读取发生在会话工作区边界内，不提供任意电脑文件浏览，也不提供远程桌面。暂停/取消下载与关闭文档标签不会停止本地 Agent 任务。

锁屏与休眠不同：仅锁屏不主动停用插件；电脑休眠、断网、退出 DSH 后无法维持正常远控。睡眠恢复和真实手机的长期后台行为应在自己的设备上验证。

首版沿用此前部署验证过的 compat.11 功能；公开版本重新构建并执行发布检查。具体测试数量与平台见 [Release notes](https://github.com/liangkw16/dsh-web-control/releases/tag/v0.1.0)，制品哈希见其 manifest。历史测试不等于对任意未来 DSH 版本的保证。
