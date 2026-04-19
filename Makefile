JS ?= $(shell command -v bun >/dev/null 2>&1 && echo bun || echo npm)

ifeq ($(JS),bun)
JS_INSTALL := bun install
JS_RUN := bun run
else
JS_INSTALL := npm install --no-audit --no-fund
JS_RUN := npm run
endif

.PHONY: help install check fix \
        lint lint-server lint-mobile \
        fmt fmt-server fmt-mobile \
        fmt-check fmt-check-server fmt-check-mobile \
        typecheck test test-server vet

help:
	@echo "Targets:"
	@echo "  install       Install server modules + mobile deps"
	@echo "  check         fmt-check + lint + typecheck + test (what CI runs)"
	@echo "  fix           Auto-apply fmt + lint fixes"
	@echo "  fmt           Format everything"
	@echo "  fmt-check     Check formatting only"
	@echo "  lint          Lint everything"
	@echo "  typecheck     TypeScript --noEmit"
	@echo "  test          Run server tests"
	@echo "  vet           go vet ./server/..."

install:
	cd server && go mod tidy
	cd mobile && $(JS_INSTALL)

check: fmt-check lint typecheck test

fix: fmt lint-fix

# ── lint ──────────────────────────────────────────────────────────────

lint: lint-server lint-mobile

lint-server:
	cd server && golangci-lint run ./...

lint-mobile:
	cd mobile && $(JS_RUN) lint

lint-fix:
	cd server && golangci-lint run --fix ./...
	cd mobile && $(JS_RUN) lint:fix

# ── format ────────────────────────────────────────────────────────────

fmt: fmt-server fmt-mobile

fmt-server:
	cd server && golangci-lint fmt ./...

fmt-mobile:
	cd mobile && $(JS_RUN) fmt

fmt-check: fmt-check-server fmt-check-mobile

fmt-check-server:
	cd server && golangci-lint fmt --diff ./...

fmt-check-mobile:
	cd mobile && $(JS_RUN) fmt:check

# ── other ─────────────────────────────────────────────────────────────

typecheck:
	cd mobile && $(JS_RUN) typecheck

test: test-server

test-server:
	cd server && go test ./... -race -count=1

vet:
	cd server && go vet ./...
