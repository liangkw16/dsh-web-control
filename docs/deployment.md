# 自托管 Relay

首版提供 `dsh-web-control-deploy-0.1.0.tar.gz`，包含 Docker 构建源码、固定版本原版 UI 与许可证、Compose、Caddy 和 Nginx 示例。它不含任何凭据、数据库或预设的公共服务地址。

## 域名 + Docker Compose

需要 Linux、Docker Engine/Compose、Node.js 24.x、指向服务器的域名，以及可达的 TCP 80/443。以独立的非 root 部署用户操作；其 UID/GID 将用于 Relay 和密钥文件。

```sh
# 下载 Release 中的部署包与 SHA256SUMS 后，先核验该文件的 SHA256。
# Linux: sha256sum FILE；macOS: shasum -a 256 FILE。
tar -xzf dsh-web-control-deploy-0.1.0.tar.gz
cd dsh-web-control-deploy-0.1.0
node scripts/configure-deploy.mjs --local-candidate   --domain control.example.com --platform linux/amd64
node scripts/configure-deploy.mjs --check --local-candidate
docker compose --env-file deploy/.env -f deploy/compose.yaml config
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --wait
curl --fail https://control.example.com/health/ready
```

`--local-candidate` 是现有配置工具对“在部署机本地构建并按镜像 ID 固定”的命名，不会上传镜像，也不会连接其他机器。ARM64 可改 `--platform linux/arm64`；查看 Release notes 中该架构的实际验证状态。

配置器从官方镜像仓库解析 Node/Caddy/Nginx 的真实 digest，构建 Relay，生成 `deploy/.env`、`deploy/images.lock.json` 和权限为 0600 的 `deploy/secrets/enrollment`，不打印密钥。全新解压的包包含构建清单 `manifest.json`；本地镜像按完整 ID 固定，不能把本机 ID 当作其他机器上的镜像地址。

Caddy 自动申请并续期域名证书。Relay 没有公开的容器端口，以非 root 用户和只读根文件系统运行；只写自己的命名卷与临时目录。部署前确认端口没有被其他服务占用，不要为安装插件停止无关服务。

生成首次连接配置请看[安装指南](installation.md)。无需在手机填写 Relay 注册凭据。

## 已有网关 / IP:port

可通过已有 Nginx 提供 `https://203.0.113.25:8443` 这样的固定 origin，但必须使用包含该 IP SAN、被正常信任且能自动续期的证书。文中的 `203.0.113.25` 是文档保留地址，请替换为自己的公网 IP。

使用自有 Compose override 去掉 Caddy，只把 Relay 映射到 `127.0.0.1:18787:8787`，将 `PUBLIC_ORIGIN` 改成完整 HTTPS origin。按 [nginx.conf.example](../deploy/nginx.conf.example)配置 WebSocket Upgrade 和超时，网关保留原始 Origin。安全组仅开放实际 HTTPS 端口，不能公开裸 HTTP Relay。

浏览器、Host、导入配置和服务器 `PUBLIC_ORIGIN` 的协议、主机、端口必须完全一致。不使用忽略证书错误或关闭 TLS 校验的配置。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `PUBLIC_ORIGIN` | 精确的外部 HTTPS origin |
| `DATABASE_PATH` | Relay SQLite 数据库路径 |
| `ENROLLMENT_SECRET_FILE` | 私有注册凭据文件 |
| `STATIC_DIR` | 带完整性清单的原版 UI 资源目录 |
| `HEARTBEAT_MS` / `LEASE_TTL_MS` | 心跳及控制租约时间 |
| `BUFFERED_BYTES` | 发送背压上限 |
| `MAX_CALLS` / `MAX_STREAMS` / `MAX_UPLOADS` | 并发上限 |

保留默认限额开始运行。更改 origin 需要同步设备配置；不应通过反代偷偷重写它。

## 运维、升级和回退

- `docker compose ... ps` 查看健康状态。不要在反代记录控制 URL、Cookie、Authorization 或请求正文。
- 保留 `relay_data`、`caddy_data` 卷和私有 enrollment 文件；不要使用 `down -v` 作为常规升级操作。
- SQLite 备份使用镜像 CLI 的 `backup`；例如 `docker compose --env-file deploy/.env -f deploy/compose.yaml exec relay node dist/cli.js backup --destination /data/backup-before-upgrade.sqlite`（目标文件须不存在），再通过 `docker compose cp` 将备份保存到私有离机位置。不要复制运行中的单独主库文件而漏掉 WAL。
- 升级前保存当前 `deploy/.env` 与镜像 ID，备份数据库，验证新制品校验和，先在独立环境试运行。升级容器会短暂断开远控，但不应重启桌面 DSH。
- 回退恢复先前镜像引用并重新创建 Relay 容器，保留当前数据卷。数据库恢复必须在 Relay 停止时单独执行，并确认 schema 兼容；不能顺带把旧库覆盖回去。

公网验收请使用自建测试会话：消息同步、文件预览、下载字节、重新连接、控制页面接替。真实手机与蜂窝网络应由部署者补做；模拟视口不是设备认证。
