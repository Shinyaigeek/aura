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
| `mobile-v*`  | GitHub release published       | iOS + Android builds via EAS (internal distribution)                  |

To cut a release:

```sh
# server
gh release create server-v0.1.0 --generate-notes --title "aura-server v0.1.0"

# mobile
gh release create mobile-v0.1.0 --generate-notes --title "aura mobile v0.1.0"
```

Pull requests and pushes to `main` run the `ci` workflow: `go vet / go
test` for the server and `tsc --noEmit` for the mobile app.

## Required secrets

Configure these in **Settings → Secrets and variables → Actions**:

- `EXPO_TOKEN` — personal access token from
  [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens).
  Required by `mobile-release.yml` to launch EAS builds.

The server workflow only uses the built-in `GITHUB_TOKEN`.

## Installing a mobile release build

EAS builds land on your Expo dashboard rather than on the GitHub
release (they're too big and often require signing credentials that
shouldn't leave EAS).

- **iOS**: use an internal-distribution build (ad-hoc or TestFlight)
  via `eas submit` once signing is configured. For the first
  Apple-Developer-free pass, just run the app via Expo Go.
- **Android**: download the `.apk` from the EAS build page and
  sideload it, or attach it to the GitHub release manually.

## Status

Bootstrapping. Stack choices are not final — see issues.
