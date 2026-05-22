# Security Policy

## Threat model — read this before deploying

aura-server is, by design, **remote shell access to the host it runs on**.
Anyone who can reach the server *and* presents a valid `AURA_TOKEN` can:

- run arbitrary commands as the user that owns the `aura-server` process
  (this is the whole point — it spawns a shell inside tmux);
- **read any file** that user can read, via the `readfile` WebSocket
  message (no path is off-limits beyond OS permissions — `~/.ssh/`,
  `/etc/`, etc.);
- list arbitrary directories via `listdir`;
- upload files into a session's working directory.

In other words, the `AURA_TOKEN` is **root-equivalent over that host's
user account**. Treat it like an SSH private key.

### Deploy safely

- **Never expose `aura-server` directly to the public internet.** Put it
  behind a private network only you can reach: Tailscale / WireGuard, an
  SSH tunnel, or a LAN you trust.
- The default transport is **plaintext `ws://`** — the token and all
  terminal I/O travel unencrypted. If traffic leaves a trusted link,
  terminate TLS at a reverse proxy (`wss://`) in front of aura-server.
- Generate `AURA_TOKEN` with real entropy (`openssl rand -hex 32`) and
  keep it out of shell history and version control.
- Prefer passing the token via the `Authorization: Bearer` header or the
  `bearer.<token>` WebSocket subprotocol rather than the `?token=` query
  parameter, which can leak into proxy/access logs.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
**Security → Report a vulnerability** on the repository.

We aim to acknowledge reports within a few days. As an early-stage
personal project there is no formal SLA, but credible reports will be
triaged and fixed as a priority.

## Supported versions

Only the latest `server-v*` and `mobile-v*` releases receive fixes.
aura is pre-1.0 and makes no backward-compatibility guarantees yet.
