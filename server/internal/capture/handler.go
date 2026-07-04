// Package capture serves the full scrollback of a tmux-backed session as
// plain text, so the mobile copy feature can reach output that has scrolled
// off the visible terminal.
package capture

import (
	"io"
	"net/http"
)

// Capturer resolves an aura session id to its pane contents (scrollback +
// visible). Broken out as a func type so tests don't have to shell out to
// tmux.
type Capturer func(sessionID string) (string, error)

// NewHandler handles GET /sessions/{id}/capture. Returns the pane text as
// text/plain; a session that isn't running in tmux (or any capture failure)
// is a 404 so the client can fall back to its on-device buffer dump.
func NewHandler(capture Capturer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		text, err := capture(id)
		if err != nil {
			http.Error(w, "capture unavailable", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, text)
	})
}
