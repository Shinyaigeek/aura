# aura-mobile

Expo (React Native) app that renders a terminal via xterm.js inside a
WebView and proxies PTY I/O over a WebSocket to `aura-server`.

## Why WebView + xterm.js

xterm.js is the terminal emulator used by VS Code, Hyper, and countless
others — ANSI handling, wide chars, unicode, scrollback, addons. Building
the same thing as a native view is possible but is a multi-month project
on its own. Wrapping xterm.js in a WebView is pragmatic and gives us
identical rendering to desktop browsers, which is what the user already
had working with `ghostty-web`.

## Why the session is durable

The client does not hold terminal state; the server's tmux session does.
If the app is backgrounded, the OS kills the WebSocket, the RN runtime
unloads, or the network dies, we:

1. On reopen, `WsClient.kick()` (triggered by `AppState` flipping to
   `active`) forces a reconnect with zero backoff.
2. The reconnect targets `?session=<sessionId>`, which on the server
   maps to `tmux new-session -A -s aura-<id>` — "attach if exists, else
   create".
3. xterm.js redraws from whatever the tmux scrollback sends back.

The running process (claude, a shell, whatever) is owned by tmux on the
server and never saw the disconnect.

## Quick test on a physical device (Expo Go)

All of aura's current native deps (`react-native-webview`,
`@react-native-async-storage/async-storage`, navigation, safe-area,
screens) ship inside Expo Go, so no custom native build is needed to
try it.

On your phone:

1. Install **Expo Go** from the App Store / Play Store.

On your laptop:

```sh
cd mobile
npm install
npx expo start --tunnel
```

Scan the QR code in the terminal with Expo Go (Android) or the Camera
app (iOS). The app will load, and on first launch open **Settings** to
enter server URL / token / session id.

> `--tunnel` routes through Expo's relay, so the phone does not need to
> be on the same network as your laptop. Drop it to `--lan` once you
> are at home for lower latency.

## Native build (standalone app)

When you outgrow Expo Go — custom native modules, release builds,
background behavior — build standalone:

```sh
cd mobile
npm install
npx expo prebuild           # generates ios/ and android/ projects
npx expo run:ios            # or: npx expo run:android
```

## Settings

- **Server URL** — e.g. `ws://desktop.lan:8787` (no path; `/ws` is
  appended).
- **Auth token** — matches `AURA_TOKEN` on the server.
- **Session id** — defaults to `default`. Distinct ids give you
  independent tmux sessions.
