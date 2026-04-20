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

	"github.com/Shinyaigeek/aura/server/internal/devices"
	"github.com/Shinyaigeek/aura/server/internal/push"
)

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
// The body is intentionally permissive: the shell-side hook script may POST
// the raw Claude Code event JSON, or a slim {sessionId, title, body} shape.
// We only read what we need and ignore the rest.
func NewStopHookHandler(store Registrar, pusher Pusher) http.Handler {
	type body struct {
		SessionID string `json:"sessionId"`
		Title     string `json:"title"`
		Body      string `json:"body"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in body
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		sessionID := strings.TrimSpace(in.SessionID)
		title := strings.TrimSpace(in.Title)
		if title == "" {
			title = "Claude Code"
		}
		msgBody := strings.TrimSpace(in.Body)
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
