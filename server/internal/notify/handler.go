// Package notify wires Claude Code hook callbacks to mobile push
// notifications.
//
// The flow is:
//
//  1. The mobile app registers its Expo push token via POST /devices/register.
//  2. Claude Code's Stop hook, running inside a tmux pane on this host, POSTs
//     to /hooks/stop with the AURA_SESSION_ID that aura-server exported into
//     the pane's environment.
//  3. This package fans the event out to every registered device and prunes
//     any tokens Expo tells us are dead.
package notify

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Shinyaigeek/aura/server/internal/ccmeta"
	"github.com/Shinyaigeek/aura/server/internal/devices"
	"github.com/Shinyaigeek/aura/server/internal/push"
)

// CwdLookup resolves an aura session id to the cwd of its tmux pane. Broken
// out as an interface so tests don't have to shell out to tmux.
type CwdLookup func(sessionID string) (string, error)

// TitleReader abstracts ccmeta.Cache so tests can stub the filesystem.
type TitleReader interface {
	LookupByCwd(cwd string) (ccmeta.Meta, error)
	ReadPath(path string) (ccmeta.Meta, error)
}

// Pusher is the subset of *push.Client this package needs. Kept as an
// interface so tests can swap in a fake without hitting Expo.
type Pusher interface {
	Send(ctx context.Context, msgs []push.Message) ([]push.Ticket, error)
}

// Registrar is the subset of *devices.Store this package needs.
type Registrar interface {
	Register(token, platform string) error
	Remove(token string) error
	List() []devices.Device
}

// NewRegisterHandler handles POST /devices/register.
func NewRegisterHandler(store Registrar) http.Handler {
	type body struct {
		ExpoPushToken string `json:"expoPushToken"`
		Platform      string `json:"platform"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in body
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		token := strings.TrimSpace(in.ExpoPushToken)
		if token == "" {
			http.Error(w, "expoPushToken required", http.StatusBadRequest)
			return
		}
		if err := store.Register(token, strings.TrimSpace(in.Platform)); err != nil {
			slog.Error("device register failed", "err", err)
			http.Error(w, "register failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// NewStopHookHandler handles POST /hooks/stop.
//
// Accepts both the legacy slim shape ({sessionId, title, body}) and CC's
// native hook payload (which carries transcript_path). When a transcript
// path arrives and we can read a first user message from it, that prompt
// becomes the push-notification body — way more useful than "Session X is
// ready".
//
// titles is nil-safe: if the caller doesn't wire up a TitleReader the
// handler falls back to the legacy behaviour.
func NewStopHookHandler(store Registrar, pusher Pusher, titles TitleReader) http.Handler {
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
		// Prefer the explicit header (set by the updated hook command) over
		// the body field, which is only there for the old shell one-liner.
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

		list := store.List()
		if len(list) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		msgs := make([]push.Message, 0, len(list))
		for _, d := range list {
			msgs = append(msgs, push.Message{
				To:    d.ExpoPushToken,
				Title: title,
				Body:  msgBody,
				Sound: "default",
				Data:  map[string]any{"sessionId": sessionID},
			})
		}

		tickets, err := pusher.Send(r.Context(), msgs)
		if err != nil {
			slog.Error("push send failed", "err", err)
			http.Error(w, "push failed", http.StatusBadGateway)
			return
		}
		for i, t := range tickets {
			if i >= len(list) {
				break
			}
			if t.IsDeviceNotRegistered() {
				if err := store.Remove(list[i].ExpoPushToken); err != nil {
					slog.Warn("prune dead device token failed", "err", err)
				}
			} else if t.Status == "error" {
				slog.Warn("push ticket error", "err", t.Message, "code", t.Details.Error)
			}
		}
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
			slog.Warn("ccmeta lookup failed", "id", id, "cwd", cwd, "err", err)
			writeJSON(w, ccmeta.Meta{Cwd: cwd})
			return
		}
		writeJSON(w, meta)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write json failed", "err", err)
	}
}
