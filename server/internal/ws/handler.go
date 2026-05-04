// Package ws exposes the WebSocket endpoint that bridges client I/O to a
// tmux-backed PTY.
//
// Wire protocol:
//
//   - Binary frames from client → server: raw stdin bytes for the PTY.
//   - Binary frames from server → client: raw stdout bytes from the PTY.
//   - Text frames from client → server: JSON control messages.
//   - Text frames from server → client: JSON response messages (correlated
//     with requests by id).
//
// Client → server control messages:
//
//	{"type":"resize","rows":40,"cols":120}
//	{"type":"ping"}
//	{"type":"cwd","id":"r1"}
//	{"type":"listdir","id":"r2","path":"/home/user","dirsOnly":false}
//	{"type":"readfile","id":"r3","path":"/home/user/file.go"}
//
// Server → client responses:
//
//	{"type":"cwd_response","id":"r1","path":"/home/user/project"}
//	{"type":"listdir_response","id":"r2","path":"/home/user","entries":[{"name":"src","isDir":true}]}
//	{"type":"readfile_response","id":"r3","path":"/home/user/file.go","content":"...","size":123,"truncated":false,"binary":false}
//	{"type":"error","id":"r2","message":"..."}
package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/coder/websocket"

	"github.com/Shinyaigeek/aura/server/internal/session"
	"github.com/Shinyaigeek/aura/server/internal/tmux"
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
				// Copy the frame: `data` is only valid until the next Read.
				// Dispatch off-loop so slow handlers (tmux exec, filesystem
				// reads) don't stall PTY input.
				payload := append([]byte(nil), data...)
				go handleControl(ctx, conn, sess, payload)
			}
		}
	})
}

type controlMsg struct {
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Path     string `json:"path,omitempty"`
	DirsOnly bool   `json:"dirsOnly,omitempty"`
}

type cwdResponse struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Path string `json:"path"`
}

type listdirResponse struct {
	Type    string     `json:"type"`
	ID      string     `json:"id"`
	Path    string     `json:"path"`
	Entries []dirEntry `json:"entries"`
}

type readfileResponse struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

type errorResponse struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Message string `json:"message"`
}

func handleControl(ctx context.Context, conn *websocket.Conn, sess *session.Session, raw []byte) {
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
	case "cwd":
		path, err := tmux.PaneCurrentPath(sess.ID)
		if err != nil {
			writeJSON(ctx, conn, errorResponse{Type: "error", ID: msg.ID, Message: err.Error()})
			return
		}
		writeJSON(ctx, conn, cwdResponse{Type: "cwd_response", ID: msg.ID, Path: path})
	case "listdir":
		entries, err := listEntries(msg.Path, msg.DirsOnly)
		if err != nil {
			writeJSON(ctx, conn, errorResponse{Type: "error", ID: msg.ID, Message: err.Error()})
			return
		}
		writeJSON(ctx, conn, listdirResponse{
			Type:    "listdir_response",
			ID:      msg.ID,
			Path:    filepath.Clean(msg.Path),
			Entries: entries,
		})
	case "readfile":
		res, err := readFileForViewer(msg.Path)
		if err != nil {
			writeJSON(ctx, conn, errorResponse{Type: "error", ID: msg.ID, Message: err.Error()})
			return
		}
		writeJSON(ctx, conn, readfileResponse{
			Type:      "readfile_response",
			ID:        msg.ID,
			Path:      res.Path,
			Content:   res.Content,
			Size:      res.Size,
			Truncated: res.Truncated,
			Binary:    res.Binary,
		})
	}
}

func writeJSON(ctx context.Context, conn *websocket.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshal response failed", "err", err)
		return
	}
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		slog.Debug("ws text write failed", "err", err)
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
