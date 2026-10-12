# 安装与首次连接

## 前提

- DSH **0.2.0-rc.2**。升级 DSH 前先查看兼容性说明。
- 已部署的 HTTPS Relay，证书被电脑和手机正常信任。
- 下载 [Release](https://github.com/liangkw16/dsh-web-control/releases) 内预构建插件，并用 `SHA256SUMS` 校验。

## 桌面 App

在「插件 → 添加插件」选择本地 `.tgz` 路径，安装后启用。插件提供「设置 → 网页远控」页面。安装包只包含自己的 Host/Client 代码，DSH 核心服务使用 peer dependencies，不另装一份核心运行时。

首次连接由 Relay 管理者在服务器生成私有配置：

```sh
node scripts/create-connection-config.mjs   --origin https://control.example.com   --secret-file deploy/secrets/enrollment   --output /private/path/web-control-connection.json
```

通过自己信任的私有渠道把配置传到电脑，在「网页远控」导入并启用。配置包含注册凭据，不能放入公开仓库、Issue、截图或聊天公开链接。已经配对的设备无需再次导入；日常只需打开控制链接。

注册凭据用于限制哪些电脑可以加入你自己的 Relay；浏览器访问会话使用的是另一份控制链接权限。普通使用者不需要手动输入注册密钥。

## CLI / DSH Web

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-web-control-0.1.0.tgz
```

在这个 profile 的 DSH Web 中启用并配对。不要将空白测试 profile 与桌面 App 当前 profile 混淆。参见[官方打包安装说明](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。

## 日常使用

复制链接或扫描二维码。新的控制页面会接替之前的页面；旧页面失去控制权。关闭设置页面不会关闭 Host 连接，锁屏也不依赖桌面自动化。

- “刷新链接”会轮换浏览器链接，之前的链接失效；只在希望撤销旧链接时使用。
- “停止远控”停止远程接入，不等于停止 DSH 自己的 Agent 任务。
- 不要把链接贴进公开 Issue。排障只提供经过脱敏的错误码。

## 升级与卸载

先保留旧插件包和 Relay 镜像，阅读 Release notes，再通过官方插件管理器替换并启用新包。保持同一 profile 和凭据存储，避免重新生成设备身份。若 App 要求重启，应等待任务安全结束后再操作。

停用或卸载插件会断开远控；本地会话由 DSH 管理。不要删除 DSH profile 或其他插件。Relay 回退见[部署文档](deployment.md)。
