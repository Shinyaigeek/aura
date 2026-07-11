// Package capture serves the full scrollback of a tmux-backed session, so the
// mobile copy feature can reach output that has scrolled off the visible
// terminal, and the mobile Session Reload can repaint from a fresh snapshot.
package capture

import (
	"io"
	"net/http"
)

// Capturer resolves an aura session id to its pane contents (scrollback +
// visible). ansi selects whether SGR escape sequences are included: the copy
// feature wants plain text, Session Reload wants colour. Broken out as a func
// type so tests don't have to shell out to tmux.
type Capturer func(sessionID string, ansi bool) (string, error)

// NewHandler handles GET /sessions/{id}/capture. Returns the pane text as
// text/plain; a session that isn't running in tmux (or any capture failure)
// is a 404 so the client can fall back to its on-device buffer dump. The
// optional ?ansi=1 query includes colour escapes (used by Session Reload);
// omitting it keeps the historical plain-text behaviour the copy feature
// relies on.
func NewHandler(capture Capturer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		ansi := r.URL.Query().Get("ansi") == "1"
		text, err := capture(id, ansi)
		if err != nil {
			http.Error(w, "capture unavailable", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, text)
	})
}
