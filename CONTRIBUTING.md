# Contributing to aura

Thanks for your interest in aura. This is an early-stage personal
project — see [`README.md`](README.md) for the design and current
status — but issues and pull requests are welcome.

## Repository layout

- `server/` — Go HTTP/WebSocket server (`aura-server`). See
  [`server/README.md`](server/README.md).
- `mobile/` — Expo / React Native app. See
  [`mobile/README.md`](mobile/README.md).

The two halves release independently, so a change usually touches only
one of them.

## Prerequisites

- **Go** 1.22+ and [`golangci-lint`](https://golangci-lint.run/) — for
  the server.
- **[bun](https://bun.sh/)** (preferred) or npm — for the mobile app.
  The `Makefile` auto-detects whichever is installed.
- **tmux** on the host if you want to actually run `aura-server`.

## Getting started

```sh
make install     # server modules + mobile deps
make check       # everything CI runs: fmt-check + lint + typecheck + test
make fix         # auto-apply formatting and safe lint fixes
```

Run `make help` for the full target list — component-scoped targets
exist too (`make test-server`, `make lint-mobile`, …).

## Before opening a pull request

1. Run `make check` and make sure it passes. CI runs the exact same
   checks: `golangci-lint` and `go test -race` for the server; `oxfmt`,
   `oxlint`, and `tsc --noEmit` for the mobile app.
2. Keep changes focused — server-only and mobile-only PRs are the
   easiest to review.
3. Add or update tests when you change server behavior; each server
   package has tests alongside it.

Pull requests and pushes to `main` run the `ci` workflow automatically.

## Commit messages

This repo follows Conventional Commit style with a component scope,
e.g. `feat(mobile): …`, `fix(server): …`, `chore(mobile): …`. Match the
existing history.

## Security

Please do **not** report security issues in public issues or pull
requests. See [`SECURITY.md`](SECURITY.md) for the private disclosure
process.

## License

By contributing, you agree that your contributions are licensed under
the [MIT License](LICENSE).
