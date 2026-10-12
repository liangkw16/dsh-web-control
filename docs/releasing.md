# Release procedure

## Official discovery channel

Checked on 2026-10-12: [DeepSeek's official Harness site](https://deepseek.com/harness/) links “Community plugins” to [GitHub topic dsh-plugin](https://github.com/topics/dsh-plugin). Add that topic, `deepseek-harness`, `remote-control` and `self-hosted` to this repository. Topic membership is discovery metadata, not an official approval or security review.

Search also finds independent community registries such as [DSH Plugin Registry](https://github.com/dshplugin-app/deepseek-harness-plugins). Its own README says it is not affiliated with DeepSeek. Do not label any independent directory as the official marketplace, and do not claim automatic indexing before observing it.

The [official packaging guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) supports prebuilt tarballs. This monorepo distributes the built plugin that way; installing the repository root directly is not supported. No npm name or registry publish is claimed for v0.1.0.

## Build inputs

Node.js 24.x, pnpm 11.25.0, Git, Python 3, tar and Docker. Chromium/WebKit are needed for browser gates. Keep all production DSH profiles and credentials outside the build checkout.

The first public snapshot keeps runtime source from the deployed compat.11 implementation, changes package version/metadata, makes fixture paths portable, and adds release tooling/documentation. Historical private deployment receipts, screenshots and commit history are deliberately not distributed.

Pinned native UI inputs are distributed as `dsh-web-control-native-inputs-0.1.0.tar.gz`; verify its SHA256 against the release checksum file, then extract to `data/native-inputs`. These are public rc.2 business resources, a separate startup adaptation and frozen legacy test assets, with license/hash manifests. They contain no profile, session or credential data. `tests/fixtures/legacy-release` is an intentional immutable compatibility fixture, not current production credentials or a live endpoint.

To regenerate native inputs from public packages, prepare the isolated stock runtime with `pnpm compat -- --surface web` (set `WEB_CONTROL_PNPM_CLI` to the absolute `node_modules/pnpm/bin/pnpm.mjs` path), then run `pnpm test:native`. Each test writes an owned `data/native-ui/core-*/artifacts` and `startup` directory. Use one passing run's directories plus `tests/fixtures/legacy-release` as the three input directories. Startup code remains separate from unchanged stock business resources. Review upstream licenses and record resource provenance when changing DSH versions.

## Validation and packaging

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
python3 tests/compat/native-ui-remote.test.py
pnpm exec playwright install chromium webkit
# Requires the isolated stock runtime; never an actual user's DSH_HOME.
pnpm test:native
pnpm test:parity
# Stage/commit reviewed source before recording source provenance.
pnpm package:release --inputs data/native-inputs --output dist/public-release
```

The package command requires a completed build and refuses to overwrite its output directory. Run it after browser tests finish: those tests rebuild the plugin and must not run concurrently with packaging. It verifies original resources and newly built plugin imports, assembles a native UI deployment kit, retains third-party notices and creates checksums. Do not call a packaging manifest a test pass: record the commands actually run in release notes.

Outputs:

| Artifact | Use |
| --- | --- |
| `dsh-web-control-0.1.0.tgz` | Install in DSH's plugin manager |
| `dsh-web-control-deploy-0.1.0.tar.gz` | Source + native assets for Docker deployment |
| `dsh-web-control-native-inputs-0.1.0.tar.gz` | Reproduce native assembly and run compatibility work |
| `release-manifest.json` | Version, source commit and artifact hashes |
| `SHA256SUMS` | Download integrity checks |

Test the extracted deployment kit, not only the working tree. Build a target Linux image and verify SQLite startup, `/health/ready`, UI resource integrity and a native control flow with an owned Host. Save private raw logs locally; publish only sanitized verification summaries. The historical `scripts/task*`, `acceptance*` and `native-ui-release` pipelines remain audit/regression tooling for earlier sealed private candidates, not instructions to redeploy a personal server.

After running the deployment kit's `configure-deploy.mjs`, the dedicated public release smoke binds its image identity to the release archives, checks all native assets through an isolated TLS proxy, and exercises the original UI, preview/download and page takeover while a synthetic local task runs:

```sh
node scripts/smoke-public-release.mjs --release dist/public-release \
  --image-lock /path/to/extracted-kit/deploy/images.lock.json
```

It uses the isolated stock runtime prepared above. Its temporary self-signed certificate is trusted only inside this test; do not copy that certificate setup into production. The test removes its own containers and stops its own Host, without connecting to a user profile.

Create a GitHub tag matching the plugin version, publish release notes and upload only the allowlisted artifacts above. Verify public downloads against local checksums. Keep tags/assets immutable; fixes get a new patch release. Update `CHANGELOG.md`, compatibility notes and the package's versioned Host entry together. No release operation should restart the user's DSH or replace an existing Relay automatically.
