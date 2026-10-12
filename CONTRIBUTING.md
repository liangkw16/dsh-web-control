# Contributing

Use Node.js 24.x and pnpm 11.25.0. Install with `pnpm install --frozen-lockfile`, then run `pnpm build`, `pnpm typecheck` and `pnpm test`. The default suite excludes real published-install and deployment gates that need separately prepared artifacts. Those exclusions are explicit, not reported as passing tests.

Keep changes in the smallest public bridge possible. Reuse stock DSH UI and services; do not copy business UI into a parallel implementation, patch the user's DSH installation or weaken the Host authorization boundary to match a visible button.

For a protocol, authority, lifecycle or file-boundary change, add a meaningful regression and run affected tests. For current-file changes, run both macOS and Linux containment tests and native preview/download cases. See [releasing](docs/releasing.md) for browser fixture prerequisites. Fixtures must use a new DSH_HOME, owned processes and loopback endpoints. Never attach to a running user's Host for automated tests.

Before opening a PR:

- State the concrete behavior change, supported versions and relevant validation.
- Keep credentials, production logs, deployment receipts, private screenshots and local paths out of the diff.
- Retain dependency licenses and source provenance.
- Do not include `node_modules`, generated personal profiles, databases or arbitrary build artifacts.

Use issues for reproducible bugs and focused feature requests. Be respectful and discuss technical tradeoffs directly. Security issues belong in a [private advisory](https://github.com/liangkw16/dsh-web-control/security/advisories/new).
