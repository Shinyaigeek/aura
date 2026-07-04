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
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Shinyaigeek/aura/server/internal/auth"
	"github.com/Shinyaigeek/aura/server/internal/capture"
	"github.com/Shinyaigeek/aura/server/internal/ccmeta"
	"github.com/Shinyaigeek/aura/server/internal/difit"
	"github.com/Shinyaigeek/aura/server/internal/events"
	"github.com/Shinyaigeek/aura/server/internal/notify"
	"github.com/Shinyaigeek/aura/server/internal/session"
	"github.com/Shinyaigeek/aura/server/internal/shares"
	"github.com/Shinyaigeek/aura/server/internal/tmux"
	"github.com/Shinyaigeek/aura/server/internal/upload"
	"github.com/Shinyaigeek/aura/server/internal/ws"
)

// version is the running server's version, e.g. "v0.1.0". It is stamped at
// build time via -ldflags "-X main.version=..." (see server-release.yml) and
// defaults to "dev" for local builds. Surfaced on startup, via the `version`
// subcommand / -version flag, and over GET /version so the mobile app can show
// which server it's talking to.
var version = "dev"

func main() {
	// Subcommand dispatch. Keep this surface minimal: the server is the
	// only long-running mode, side-commands (setup-hooks, etc.) are small
	// helpers that run once and exit.
	if len(os.Args) >= 2 && !strings.HasPrefix(os.Args[1], "-") {
		sub, rest := os.Args[1], os.Args[2:]
		switch sub {
		case "version":
			fmt.Println(version)
			return
		case "setup-hooks":
			if err := runSetupHooks(rest); err != nil {
				fmt.Fprintln(os.Stderr, "setup-hooks:", err)
				os.Exit(1)
			}
			return
		case "share":
			if err := runShare(rest); err != nil {
				fmt.Fprintln(os.Stderr, "share:", err)
				os.Exit(1)
			}
			return
		default:
			fmt.Fprintln(os.Stderr, "unknown subcommand:", sub)
			os.Exit(2)
		}
	}

	var (
		showVersion = flag.Bool("version", false, "print version and exit")
		addr        = flag.String("addr", ":8787", "listen address")
		token       = flag.String("token", os.Getenv("AURA_TOKEN"), "shared auth token (env AURA_TOKEN)")
		shell       = flag.String("shell", defaultShell(), "shell to run inside tmux when a new session is created")
		difitCmd    = flag.String("difit-cmd", defaultDifitCmd(), "command used to spawn difit (env AURA_DIFIT_CMD)")
		shareDir    = flag.String("share-dir", defaultShareDir(), "directory served at /shares — drop a file here to share it with the mobile app (env AURA_SHARE_DIR)")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	slog.Info("aura-server starting", "version", version)

	if *token == "" {
		slog.Warn("AURA_TOKEN is empty; server will reject all WebSocket upgrades")
	}

	// The share store serves a well-known directory at /shares. Anything a
	// process on this host writes there (a screenshot, a recording) shows
	// up in the mobile app's gallery. Created up front so we can fail fast
	// if the path is unusable and so AURA_SHARE_DIR carries the resolved
	// absolute path.
	shareStore, err := shares.NewStore(*shareDir)
	if err != nil {
		slog.Error("share dir unusable", "dir", *shareDir, "err", err)
		os.Exit(1)
	}
	slog.Info("serving shares", "dir", shareStore.Dir())

	mgr := session.NewManager(*shell)
	// Expose AURA_SESSION_ID / AURA_URL / AURA_TOKEN / AURA_SHARE_DIR to each
	// spawned shell so a Claude Code Stop hook (which runs as a subprocess of
	// that shell) can POST back here, and so Claude knows where to drop files
	// it wants to share — all without needing to know anything else about the
	// server.
	hookURL := hookCallbackURL(*addr)
	mgr.SetExtraEnv(func(id string) []string {
		env := []string{"AURA_SESSION_ID=" + id, "AURA_SHARE_DIR=" + shareStore.Dir()}
		if hookURL != "" {
			env = append(env, "AURA_URL="+hookURL)
		}
		if *token != "" {
			env = append(env, "AURA_TOKEN="+*token)
		}
		return env
	})
	authMw := auth.Token(*token)

	hub := events.New()
	titles := ccmeta.NewCache()
	cwdLookup := func(id string) (string, error) { return tmux.PaneCurrentPath(id) }

	difitMgr := difit.NewManager(*difitCmd)

	// DELETE /sessions/{id} tears down the tmux session and any difit
	// process that was spawned alongside it. The two are kept in lockstep
	// so a closed tab on the phone cleans up both halves.
	killHandler := ws.NewKillHandler(mgr)
	wrappedKill := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		difitMgr.Stop(r.PathValue("id"))
		killHandler.ServeHTTP(w, r)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// Unauthenticated like /healthz: the version is not a secret, and keeping
	// it token-free lets the mobile app display which server it's pointed at
	// even before the user has saved a token.
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":` + strconv.Quote(version) + `}`))
	})
	mux.Handle("GET /ws", authMw(ws.NewHandler(mgr)))
	mux.Handle("GET /events", authMw(events.NewHandler(hub)))
	mux.Handle("DELETE /sessions/{id}", authMw(wrappedKill))
	mux.Handle("GET /sessions/{id}/meta", authMw(notify.NewMetaHandler(cwdLookup, titles)))
	mux.Handle("GET /sessions/{id}/capture", authMw(capture.NewHandler(tmux.CapturePane)))
	mux.Handle("POST /sessions/{id}/upload", authMw(upload.NewHandler(cwdLookup)))
	mux.Handle("GET /shares", authMw(shareStore.ListHandler()))
	mux.Handle("GET /shares/{name}", authMw(shareStore.FileHandler()))
	mux.Handle("POST /sessions/{id}/difit", authMw(difit.NewStartHandler(difitMgr, cwdLookup)))
	mux.Handle("DELETE /sessions/{id}/difit", authMw(difit.NewStopHandler(difitMgr)))
	mux.Handle("POST /hooks/stop", authMw(notify.NewStopHookHandler(hub, titles)))
	mux.Handle("POST /hooks/notification", authMw(notify.NewNotificationHookHandler(hub)))

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
	difitMgr.StopAll()
}

func defaultShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/bash"
}

func defaultDifitCmd() string {
	if s := os.Getenv("AURA_DIFIT_CMD"); s != "" {
		return s
	}
	return "difit"
}

// defaultShareDir is where shared files live unless overridden. We keep it
// under ~/.aura so the path is stable and predictable: a process can share
// a file with the mobile app by writing into AURA_SHARE_DIR (injected into
// every pane) or, when it doesn't know about aura, into this fixed default.
func defaultShareDir() string {
	if s := os.Getenv("AURA_SHARE_DIR"); s != "" {
		return s
	}
	return "~/.aura/share"
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
