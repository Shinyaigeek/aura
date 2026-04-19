// Package ws exposes the WebSocket endpoint that bridges client I/O to a
// tmux-backed PTY.
//
// Wire protocol (deliberately minimal):
//
//   - Binary frames from client → server: raw stdin bytes for the PTY.
//   - Binary frames from server → client: raw stdout bytes from the PTY.
//   - Text frames from client → server: JSON control messages.
//
// Control messages:
//
//	{"type":"resize","rows":40,"cols":120}
//
// Text frames from server → client are reserved for future control messages
// (e.g. session id handshake) and are currently unused.
package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/Shinyaigeek/aura/server/internal/session"
)

type Manager interface {
	Attach(id string) (*session.Session, error)
}

// KillManager is Manager with the ability to terminate a session. Split from
// Manager so tests that only need Attach don't have to implement Kill.
type KillManager interface {
	Manager
	Kill(id string) error
}

// NewKillHandler handles DELETE /sessions/{id} — explicitly terminates a
// tmux session. The whole point of aura is that sessions outlive clients, so
// this is the single place where we deliberately break that invariant.
func NewKillHandler(mgr KillManager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		if err := mgr.Kill(id); err != nil {
			slog.Error("kill failed", "id", id, "err", err)
			http.Error(w, "kill failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func NewHandler(mgr Manager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("session")
		if id == "" {
			id = "default"
		}

		sess, err := mgr.Attach(id)
		if err != nil {
			slog.Error("attach failed", "id", id, "err", err)
			http.Error(w, "attach failed", http.StatusInternalServerError)
			return
		}

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Echo back the auth subprotocol the client used (bearer.<token>)
			// so browsers accept the handshake.
			Subprotocols:       subprotocols(r),
			InsecureSkipVerify: true,
		})
		if err != nil {
			slog.Error("ws upgrade failed", "err", err)
			return
		}

		// Unlimited message size; terminal output can chunk large.
		conn.SetReadLimit(1 << 20)

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		// PTY → WebSocket
		go func() {
			defer cancel()
			buf := make([]byte, 32*1024)
			for {
				n, err := sess.Read(buf)
				if n > 0 {
					if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
						return
					}
				}
				if err != nil {
					if !errors.Is(err, io.EOF) {
						slog.Debug("pty read ended", "id", id, "err", err)
					}
					return
				}
			}
		}()

		// WebSocket → PTY (+ control messages)
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			switch typ {
			case websocket.MessageBinary:
				if _, err := sess.Write(data); err != nil {
					return
				}
			case websocket.MessageText:
				handleControl(sess, data)
			}
		}
	})
}

type controlMsg struct {
	Type string `json:"type"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

func handleControl(sess *session.Session, raw []byte) {
	var msg controlMsg
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	switch msg.Type {
	case "resize":
		if msg.Rows > 0 && msg.Cols > 0 {
			_ = sess.Resize(msg.Rows, msg.Cols)
		}
	case "ping":
		// no-op; existence of the read is enough to reset idle timers.
	}
}

func subprotocols(r *http.Request) []string {
	// Pass through any subprotocol the client offered. The auth middleware has
	// already validated the bearer token if one was carried in the subprotocol.
	if p := r.Header.Get("Sec-WebSocket-Protocol"); p != "" {
		return []string{p}
	}
	return nil
}

// idleTimeout is unused for now but reserved: if we later want to drop
// WebSockets that have been silent for N minutes (while still keeping the
// tmux session alive for reattach), plumb it through here.
const idleTimeout = 30 * time.Minute

var _ = idleTimeout
