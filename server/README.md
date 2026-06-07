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

Print the version and exit with `./bin/aura-server -version` (or
`./bin/aura-server version`). Local builds report `dev`; release builds are
stamped with the tag via `-ldflags "-X main.version=..."`.

## Endpoints

- `GET /healthz` — liveness probe.
- `GET /version` — server version, unauthenticated: `{"version":"v0.1.0"}`
  (`"dev"` for local builds). The mobile app polls this to show which
  server it's connected to.
- `GET /ws?session=<id>` — WebSocket upgrade. Auth via `Authorization:
  Bearer <token>`, `?token=<token>`, or the `bearer.<token>`
  subprotocol.
- `DELETE /sessions/<id>` — terminates a tmux session (and any difit
  process spawned for it).
- `POST /sessions/<id>/difit` — starts (or returns) a per-session
  [difit](https://github.com/yoshiko-pg/difit) instance bound to a free
  port in the session's pane cwd. Response: `{"port":<n>}`.
- `DELETE /sessions/<id>/difit` — stops it.
- `GET /shares` — lists the files in the share directory, newest first:
  `[{"name","size","modUnix","mime","url"}]`.
- `GET /shares/<name>` — streams one shared file (supports HTTP range, so
  the app can scrub video).
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

## Sharing files back to the phone

The reverse of upload: a program on the host hands a file (a screenshot,
a screen recording, a generated chart) to the mobile user by dropping it
into the **share directory**, which aura-server serves at `/shares`. The
mobile app has a "Shared with you" gallery (the ▦ button) that lists and
previews whatever lands there.

- Default directory: `~/.aura/share`. Override with `-share-dir <path>`
  or the `AURA_SHARE_DIR` env var. It is created on startup.
- aura-server injects `AURA_SHARE_DIR` into every tmux pane, so a process
  running inside an aura session — e.g. Claude Code — can share with:

  ```sh
  cp screenshot.png "$AURA_SHARE_DIR/"
  ```

- Outside aura (Claude Code run directly on the host, no server pane),
  the same default path applies. The bundled helper copies a file into
  the share dir and works whether or not the server is running:

  ```sh
  aura-server share screenshot.png        # → prints the destination path
  aura-server share -dir /custom clip.mp4
  ```

So that Claude knows the convention even outside aura, add a line to your
`~/.claude/CLAUDE.md`:

> To show me a file, copy it into `$AURA_SHARE_DIR` (default
> `~/.aura/share`), e.g. `cp out.png "$AURA_SHARE_DIR/"`.

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
Also installs `bun` and `difit` (used by the in-app diff viewer)
under `AURA_USER`, with a wrapper at `/usr/local/bin/difit` so
aura-server can spawn it from systemd's PATH.

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
