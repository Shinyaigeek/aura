# aura-server

Go HTTP/WebSocket server that owns long-lived tmux sessions and bridges
PTY I/O to mobile clients. Replaces `ghostty-web`.

## Build

```sh
cd server
go mod tidy
go build -o bin/aura-server ./cmd/aura-server
```

## Run

Requires `tmux` on the host.

```sh
export AURA_TOKEN=$(openssl rand -hex 32)
./bin/aura-server -addr :8787
```

## Endpoints

- `GET /healthz` — liveness probe.
- `GET /ws?session=<id>` — WebSocket upgrade. Auth via `Authorization:
  Bearer <token>`, `?token=<token>`, or the `bearer.<token>`
  subprotocol.
- `DELETE /sessions/<id>` — terminates a tmux session.
- `POST /devices/register` — registers a mobile Expo push token.
- `POST /hooks/stop` — Claude Code Stop-hook callback; fans a push
  notification out to every registered device.

The `session` query param picks which tmux session to attach to. If
omitted, `default` is used. The session is created on first attach and
**survives** all subsequent disconnects.

## Claude Code notifications

aura-server injects `AURA_SESSION_ID`, `AURA_URL`, and `AURA_TOKEN`
into every tmux pane it spawns, so a Claude Code Stop hook running in
that pane can call back into the server without any extra config.

Wire the hook into `~/.claude/settings.json` once:

```sh
aura-server setup-hooks
```

The subcommand patches `~/.claude/settings.json` (creating it if
missing) to install an idempotent Stop hook tagged with `# aura-hook`.
Re-running the command replaces the existing entry in place rather
than appending a duplicate. Pass `-dry-run` to preview the result, or
`-file <path>` to target a different settings file.

## Install as a systemd service

### One-shot installer

```sh
curl -fsSL https://raw.githubusercontent.com/Shinyaigeek/aura/main/server/deploy/install.sh \
  | sudo bash
```

Resolves the latest `server-v*` release, installs the binary +
systemd unit, generates a token at `/etc/aura/aura.env` on first
run (idempotent on reruns), disables any pre-existing `ghostty-web`
service, and enables + starts `aura-server`. Works on Debian/Ubuntu
(apt), Fedora/RHEL (dnf), and Arch (pacman) for the tmux dependency.

Overrides: `AURA_VERSION=server-vX.Y.Z`, `AURA_ADDR=:9000`,
`AURA_USER=other`, `SKIP_GHOSTTY=1`. See
[`deploy/install.sh`](deploy/install.sh).

### Manual

```sh
sudo install -m 0755 bin/aura-server /usr/local/bin/aura-server
sudo install -m 0644 deploy/aura-server.service /etc/systemd/system/aura-server.service
sudo install -d -m 0750 /etc/aura
sudo install -m 0640 deploy/aura.env.example /etc/aura/aura.env
sudoedit /etc/aura/aura.env   # set AURA_TOKEN
sudo systemctl daemon-reload
sudo systemctl enable --now aura-server
```

## Migrating from ghostty-web

1. Disable the existing ghostty-web service:
   `sudo systemctl disable --now ghostty-web`
2. Install aura-server as above.
3. Point the mobile app (or a browser with a WS-capable terminal) at
   `ws://<desktop>:8787/ws?session=default`.
4. Because aura-server wraps tmux, you can ssh in and run
   `tmux attach -t aura-default` from any shell to share the same
   session.
