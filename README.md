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

## Status

Bootstrapping. Stack choices are not final — see issues.
