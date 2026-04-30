package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// pingInterval is how often we send a WS ping to keep the connection
// healthy. NAT and reverse proxies tend to drop idle TCP after a few
// minutes; 30s is well under any common timeout.
const pingInterval = 30 * time.Second

// NewHandler upgrades GET /events to a WebSocket and forwards every Hub
// broadcast to the client as a JSON text frame. Auth is expected to be
// applied by middleware in the caller.
func NewHandler(hub *Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols:       subprotocols(r),
			InsecureSkipVerify: true,
		})
		if err != nil {
			slog.Error("events ws upgrade failed", "err", err)
			return
		}
		defer conn.Close(websocket.StatusInternalError, "")

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		ch, unsub := hub.Subscribe()
		defer unsub()

		// Reader goroutine: we don't read app-level messages from the
		// client (the wire is one-way server→client), but we still need
		// Read to run so disconnects are detected and Pong frames are
		// processed by the underlying library.
		go func() {
			defer cancel()
			for {
				if _, _, err := conn.Read(ctx); err != nil {
					return
				}
			}
		}()

		ping := time.NewTicker(pingInterval)
		defer ping.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ping.C:
				if err := conn.Ping(ctx); err != nil {
					return
				}
			case ev, ok := <-ch:
				if !ok {
					return
				}
				b, err := json.Marshal(ev)
				if err != nil {
					slog.Error("marshal event failed", "err", err)
					continue
				}
				if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
					return
				}
			}
		}
	})
}

func subprotocols(r *http.Request) []string {
	if p := r.Header.Get("Sec-WebSocket-Protocol"); p != "" {
		// Echo back exactly one subprotocol: pick the first the client offered.
		// The auth middleware has already validated any bearer.<token> entry.
		first := strings.TrimSpace(strings.SplitN(p, ",", 2)[0])
		if first != "" {
			return []string{first}
		}
	}
	return nil
}
