# DSH Web Control

[中文](README.md) · [Installation](docs/installation.md) · [Deployment](docs/deployment.md) · [Releases](https://github.com/liangkw16/dsh-web-control/releases)

Take over a running DeepSeek Harness session from a desktop or mobile browser using a link or QR code. The project reuses the stock DSH Web UI and adds a small authentication, transport and capability bridge.

**Independent community project; not affiliated with or endorsed by DeepSeek.** Version 0.1.0 targets **DSH 0.2.0-rc.2** only. A self-hosted HTTPS Relay is required; there is no public hosted service.

## Features

- Stock conversation navigation, streaming progress, tools, approvals and message queue operations.
- One active browser controller: a new page can replace the previous page.
- Stock file cards, historical diffs, sidebar tabs and document previews, plus browser downloads and scoped uploads.
- Outbound Host connection; no inbound port exposed on your computer.
- Host connection survives closing the settings view or locking the screen. Sleep, lost network connectivity and exiting DSH interrupt access.

## Install

1. Download the plugin tarball, deployment kit and `SHA256SUMS` from [v0.1.0](https://github.com/liangkw16/dsh-web-control/releases/tag/v0.1.0).
2. Follow the [deployment guide](docs/deployment.md) to run your HTTPS Relay.
3. Install `dsh-web-control-0.1.0.tgz` through the desktop plugin manager, or:

   ```sh
   npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-web-control-0.1.0.tgz
   ```

4. Import the operator-generated private connection configuration in DSH Web Control settings once. Then open the generated control link from another browser.

The source repository is a monorepo, not a directly installable root plugin. Prebuilt tarballs do not need installation build scripts. Treat control links and setup files as credentials.

## Compatibility and security

Native business UI assets remain unchanged; the startup/transport layer provides remote compatibility. Current-file reads support validated stock macOS/Linux local providers, inside the registered session workspace, up to 32 MiB. Symlinks, outside-workspace paths and unverified SSH/virtual/custom providers are refused. Office conversion is unavailable; download the original file instead. HTML preview is static and does not execute scripts or fetch external assets.

Connections use HTTPS/WSS, **not end-to-end encryption**. The Relay operator is a trust boundary. See [security policy](SECURITY.md), [compatibility](docs/compatibility.md) and [architecture](docs/architecture.md). Mobile viewport tests are not physical-phone or cellular-network certification.

## Development

Node.js 24.x and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [releasing.md](docs/releasing.md) for native UI inputs and isolated browser tests. Never run acceptance scripts against someone else's active Host.

## License and discovery

[MIT](LICENSE); dependencies retain their own licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The DeepSeek [official website](https://deepseek.com/harness/) links community discovery to GitHub's [`dsh-plugin` topic](https://github.com/topics/dsh-plugin). This repository uses that topic; it does not imply an official review or endorsement.
