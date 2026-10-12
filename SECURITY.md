# Security policy

## Supported version

Security fixes target the latest 0.1.x release paired with DSH 0.2.0-rc.2. Other DSH versions and unverified file providers are not covered by a compatibility claim.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/liangkw16/dsh-web-control/security/advisories/new). Include affected versions, minimal reproduction and expected/actual behavior. Do not publish live control links, connection configuration, credentials or user session data. There is no guaranteed response SLA.

## Trust model

- A control link grants meaningful access to a connected Host. Keep it private and rotate it when exposed.
- The enrollment file authorizes registering a device with your Relay. Share setup configuration only with authorized device owners.
- Connections use HTTPS/WSS, not end-to-end encryption. A trusted Relay terminates TLS and routes plaintext protocol data in memory.
- The plugin executes code inside DSH and can invoke its authorized session/workspace operations. Install only from a source you trust and verify release checksums.
- Current-file operations are scoped to registered session workspaces and supported local providers. Symlinks, escapes and unknown providers are rejected. This is not a claim that all upstream document renderers have received an independent security audit.
- Keep the Relay database, secret file, backups and certificate keys private. Do not enable logs containing credentials, raw commands, file bodies or session payloads.

The deployment runs the Relay as non-root with a read-only root filesystem, exact origin checks, bounded traffic and persistent authorization state. Do not disable TLS verification, weaken CSP or expose the bare Relay HTTP port to make a setup work.
