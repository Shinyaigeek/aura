// Package notify wires Claude Code hook callbacks to the events Hub so
// connected mobile clients can surface them as local notifications.
//
// The flow is:
//
//  1. The mobile app subscribes to GET /events.
//  2. Claude Code's Stop / Notification hooks, running inside a tmux pane
//     on this host, POST to /hooks/stop or /hooks/notification with the
//     AURA_SESSION_ID that aura-server exported into the pane's
//     environment.
//  3. This package translates the hook payload into an events.Event and
//     fans it out via the Hub.
package notify

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Shinyaigeek/aura/server/internal/ccmeta"
	"github.com/Shinyaigeek/aura/server/internal/events"
)

// CwdLookup resolves an aura session id to the cwd of its tmux pane. Broken
// out as an interface so tests don't have to shell out to tmux.
type CwdLookup func(sessionID string) (string, error)

// TitleReader abstracts ccmeta.Cache so tests can stub the filesystem.
type TitleReader interface {
	LookupByCwd(cwd string) (ccmeta.Meta, error)
	ReadPath(path string) (ccmeta.Meta, error)
}

// Broadcaster is the subset of *events.Hub this package needs. Kept as an
// interface so tests can swap in a fake without spinning up a real hub.
type Broadcaster interface {
	Broadcast(events.Event)
}

// NewStopHookHandler handles POST /hooks/stop.
//
// Accepts both the legacy slim shape ({sessionId, title, body}) and CC's
// native hook payload (which carries transcript_path). When a transcript
// path arrives and we can read a first user message from it, that prompt
// becomes the event body — way more useful than "Session X is ready".
//
// titles is nil-safe: if the caller doesn't wire up a TitleReader the
// handler falls back to the legacy behaviour.
func NewStopHookHandler(hub Broadcaster, titles TitleReader) http.Handler {
	type body struct {
		SessionID      string `json:"sessionId"`
		Title          string `json:"title"`
		Body           string `json:"body"`
		TranscriptPath string `json:"transcript_path"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in body
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		// Prefer the explicit header (set by the hook command) over the
		// body field, which is only there for the old shell one-liner.
		sessionID := strings.TrimSpace(r.Header.Get("X-Aura-Session-Id"))
		if sessionID == "" {
			sessionID = strings.TrimSpace(in.SessionID)
		}
		title := strings.TrimSpace(in.Title)
		if title == "" {
			title = "Claude Code"
		}
		msgBody := strings.TrimSpace(in.Body)
		if msgBody == "" && titles != nil && in.TranscriptPath != "" {
			if m, err := titles.ReadPath(in.TranscriptPath); err == nil && m.Title != "" {
				msgBody = m.Title
			}
		}
		if msgBody == "" {
			if sessionID != "" {
				msgBody = "Session " + sessionID + " is ready"
			} else {
				msgBody = "Session complete"
			}
		}

		hub.Broadcast(events.Event{
			Type:      "stop",
			SessionID: sessionID,
			Title:     title,
			Body:      msgBody,
		})
		w.WriteHeader(http.StatusNoContent)
	})
}

// NewNotificationHookHandler handles POST /hooks/notification.
//
// Claude Code fires the Notification hook on idle ("Claude is waiting for
// your input") and on permission prompts ("Claude needs your permission
// to use Bash"). The hook command forwards CC's native payload
// unmodified, so we read the human-readable text out of the `message`
// field and surface it as the event body.
func NewNotificationHookHandler(hub Broadcaster) http.Handler {
	type body struct {
		SessionID string `json:"session_id"`
		Message   string `json:"message"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in body
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		sessionID := strings.TrimSpace(r.Header.Get("X-Aura-Session-Id"))
		if sessionID == "" {
			sessionID = strings.TrimSpace(in.SessionID)
		}
		msg := strings.TrimSpace(in.Message)
		if msg == "" {
			msg = "Claude is waiting"
		}

		hub.Broadcast(events.Event{
			Type:      "notification",
			SessionID: sessionID,
			Title:     "Claude Code",
			Body:      msg,
		})
		w.WriteHeader(http.StatusNoContent)
	})
}

// NewMetaHandler handles GET /sessions/{id}/meta. Returns the title derived
// from the Claude Code transcript associated with the tmux pane's current
// cwd, plus the cwd itself. Everything is best-effort — clients should
// treat an empty response as "no data yet", not an error.
func NewMetaHandler(cwdLookup CwdLookup, titles TitleReader) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}

		cwd, err := cwdLookup(id)
		if err != nil {
			// Session not running in tmux (yet). Respond with empty meta so
			// the client has something to render without special-casing a
			// 404 vs empty result distinction.
			writeJSON(w, ccmeta.Meta{})
			return
		}

		meta, err := titles.LookupByCwd(cwd)
		if err != nil {
			writeJSON(w, ccmeta.Meta{Cwd: cwd})
			return
		}
		writeJSON(w, meta)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
