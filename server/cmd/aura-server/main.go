package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Shinyaigeek/aura/server/internal/auth"
	"github.com/Shinyaigeek/aura/server/internal/session"
	"github.com/Shinyaigeek/aura/server/internal/ws"
)

func main() {
	var (
		addr  = flag.String("addr", ":8787", "listen address")
		token = flag.String("token", os.Getenv("AURA_TOKEN"), "shared auth token (env AURA_TOKEN)")
		shell = flag.String("shell", defaultShell(), "shell to run inside tmux when a new session is created")
	)
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	if *token == "" {
		slog.Warn("AURA_TOKEN is empty; server will reject all WebSocket upgrades")
	}

	mgr := session.NewManager(*shell)
	authMw := auth.Token(*token)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("GET /ws", authMw(ws.NewHandler(mgr)))

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
