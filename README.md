# aura

Persistent terminal sessions for Claude Code, accessible from mobile.

## Problem

Running `ghostty-web` as a service on a home desktop and accessing it from
a phone browser works, but the session is tied to the browser process.
When the browser is killed, backgrounded aggressively, or the network
blips, the PTY dies and you start over.

## Design

The fix is to move session state off the client entirely.

```
  ┌────────────┐   WebSocket    ┌──────────────────────┐
  │ mobile app │ ◄────────────► │   aura-server        │
  │ (terminal  │                │   - auth             │
  │  renderer) │                │   - WebSocket gw     │
  └────────────┘                │   - tmux/abduco      │
                                │     session manager  │
                                └──────────┬───────────┘
                                           │ PTY (attach)
                                           ▼
                                 ┌──────────────────────┐
                                 │ long-lived tmux      │
                                 │ session running      │
                                 │ `claude` / shell     │
                                 └──────────────────────┘
```

Key property: **the tmux session outlives the client.** The mobile app
is a dumb renderer that attaches/detaches. Backgrounding, network drops,
process kills — none of them touch the running `claude` process.

## Components

- `server/` — Go WebSocket server that manages tmux sessions and proxies
  PTY I/O. Replaces `ghostty-web`.
- `mobile/` — iOS/Android app. Terminal renderer + WebSocket client with
  automatic reattach on reconnect.

## Trying it today

Fastest path to run on a physical phone:

1. Install **Expo Go** on the phone.
2. `cd mobile && npm install && npx expo start --tunnel`
3. Scan the QR code.

See [`mobile/README.md`](mobile/README.md) for details. See
[`server/README.md`](server/README.md) to run `aura-server`.

## Releases

The repo has two independent release tracks:

| Tag prefix   | Trigger                        | Artifact                                                              |
| ------------ | ------------------------------ | --------------------------------------------------------------------- |
| `server-v*`  | GitHub release published       | `aura-server` tarballs for `linux/amd64` and `linux/arm64`, attached to the release |
| `mobile-v*`  | GitHub release published       | Signed Android `.apk` attached directly to the release                |

To cut a release:

```sh
# server
gh release create server-v0.1.0 --generate-notes --title "aura-server v0.1.0"

# mobile
gh release create mobile-v0.1.0 --generate-notes --title "aura mobile v0.1.0"
```

Pull requests and pushes to `main` run the `ci` workflow: `golangci-lint
run`, `golangci-lint fmt --diff`, `go test -race` for the server, and
`oxfmt --check`, `oxlint`, `tsc --noEmit` for the mobile app. Run the
same checks locally with `make check`; `make fix` auto-applies
formatting and safe lint fixes.

## Required secrets

Both workflows use only the built-in `GITHUB_TOKEN`. No third-party
accounts are required for the default Android APK release path.

## Installing a mobile release build

- **Android** (shipped by default): download `aura-<version>.apk` from
  the release page, transfer to the phone, enable "Install unknown
  apps" for your file manager, tap to install. The APK is signed with
  the Expo-generated debug key, which is fine for personal sideload —
  not for Play Store distribution.
- **iOS**: not built in CI. Apple requires a paid Developer Program
  account ($99/year) for any install on a physical device
  (ad-hoc / TestFlight / App Store). Until then, use the Expo Go path
  documented in [`mobile/README.md`](mobile/README.md).

## Status

Bootstrapping. Stack choices are not final — see issues.
