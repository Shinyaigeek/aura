package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Shinyaigeek/aura/server/internal/auth"
	"github.com/Shinyaigeek/aura/server/internal/ccmeta"
	"github.com/Shinyaigeek/aura/server/internal/devices"
	"github.com/Shinyaigeek/aura/server/internal/notify"
	"github.com/Shinyaigeek/aura/server/internal/push"
	"github.com/Shinyaigeek/aura/server/internal/session"
	"github.com/Shinyaigeek/aura/server/internal/tmux"
	"github.com/Shinyaigeek/aura/server/internal/upload"
	"github.com/Shinyaigeek/aura/server/internal/ws"
)

func main() {
	// Subcommand dispatch. Keep this surface minimal: the server is the
	// only long-running mode, side-commands (setup-hooks, etc.) are small
	// helpers that run once and exit.
	if len(os.Args) >= 2 && !strings.HasPrefix(os.Args[1], "-") {
		sub, rest := os.Args[1], os.Args[2:]
		switch sub {
		case "setup-hooks":
			if err := runSetupHooks(rest); err != nil {
				fmt.Fprintln(os.Stderr, "setup-hooks:", err)
				os.Exit(1)
			}
			return
		default:
			fmt.Fprintln(os.Stderr, "unknown subcommand:", sub)
			os.Exit(2)
		}
	}

	var (
		addr        = flag.String("addr", ":8787", "listen address")
		token       = flag.String("token", os.Getenv("AURA_TOKEN"), "shared auth token (env AURA_TOKEN)")
		shell       = flag.String("shell", defaultShell(), "shell to run inside tmux when a new session is created")
		devicesFile = flag.String("devices-file", defaultDevicesFile(), "path to device registry JSON file")
	)
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	if *token == "" {
		slog.Warn("AURA_TOKEN is empty; server will reject all WebSocket upgrades")
	}

	mgr := session.NewManager(*shell)
	// Expose AURA_SESSION_ID / AURA_URL / AURA_TOKEN to each spawned shell so
	// a Claude Code Stop hook (which runs as a subprocess of that shell) can
	// POST back here without needing to know anything about the server.
	hookURL := hookCallbackURL(*addr)
	mgr.SetExtraEnv(func(id string) []string {
		env := []string{"AURA_SESSION_ID=" + id}
		if hookURL != "" {
			env = append(env, "AURA_URL="+hookURL)
		}
		if *token != "" {
			env = append(env, "AURA_TOKEN="+*token)
		}
		return env
	})
	authMw := auth.Token(*token)

	devStore, err := devices.Open(*devicesFile)
	if err != nil {
		slog.Error("open devices store failed", "path", *devicesFile, "err", err)
		os.Exit(1)
	}
	pushClient := push.NewClient()
	titles := ccmeta.NewCache()
	cwdLookup := func(id string) (string, error) { return tmux.PaneCurrentPath(id) }

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("GET /ws", authMw(ws.NewHandler(mgr)))
	mux.Handle("DELETE /sessions/{id}", authMw(ws.NewKillHandler(mgr)))
	mux.Handle("GET /sessions/{id}/meta", authMw(notify.NewMetaHandler(cwdLookup, titles)))
	mux.Handle("POST /sessions/{id}/upload", authMw(upload.NewHandler(cwdLookup)))
	mux.Handle("POST /devices/register", authMw(notify.NewRegisterHandler(devStore)))
	mux.Handle("POST /hooks/stop", authMw(notify.NewStopHookHandler(devStore, pushClient, titles)))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("aura-server listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	mgr.CloseAll()
}

func defaultShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/bash"
}

// defaultDevicesFile resolves the JSON file used to persist registered Expo
// push tokens. Honors XDG_CONFIG_HOME, falls back to ~/.config/aura/, and
// finally to ./aura-devices.json when no home directory is resolvable.
func defaultDevicesFile() string {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "aura", "devices.json")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "aura", "devices.json")
	}
	return "aura-devices.json"
}

// hookCallbackURL turns the server's listen address into the http base URL
// that in-pane hook scripts should POST to. We always target localhost — the
// hook runs on the same host as aura-server by definition.
func hookCallbackURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return ""
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}
