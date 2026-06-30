// Package input exposes POST /sessions/{id}/input — a way to type a line of
// text into a session's Claude Code prompt over plain HTTP, without holding a
// WebSocket open.
//
// This is what lets an out-of-band caller (an Alexa skill, a cron job, a
// webhook) drive a durable session: it POSTs {"text":"..."} and the server
// injects those keystrokes into the tmux pane, Enter included. The PTY is owned
// by tmux, so the prompt lands whether or not a phone is attached.
package input

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// Sender injects a line of text into the session's pane and submits it.
// Broken out as a func type so tests don't shell out to tmux.
type Sender func(sessionID, text string) error

// Existser reports whether the session is currently alive. Injecting into a
// dead session would silently do nothing, so we check first and 404.
type Existser func(sessionID string) (bool, error)

// maxTextBytes caps a single injected prompt. Generous for a dictated sentence,
// small enough that a misbehaving caller can't shove a megabyte into the pane.
const maxTextBytes = 8 * 1024

// NewHandler handles POST /sessions/{id}/input.
func NewHandler(send Sender, exists Existser) http.Handler {
	type body struct {
		Text string `json:"text"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}

		var in body
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxTextBytes)).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		text := strings.TrimSpace(in.Text)
		if text == "" {
			http.Error(w, "empty text", http.StatusBadRequest)
			return
		}

		ok, err := exists(id)
		if err != nil {
			slog.Error("input: exists check failed", "id", id, "err", err)
			http.Error(w, "session lookup failed", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "no such session", http.StatusNotFound)
			return
		}

		if err := send(id, text); err != nil {
			slog.Error("input: send failed", "id", id, "err", err)
			http.Error(w, "send failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
