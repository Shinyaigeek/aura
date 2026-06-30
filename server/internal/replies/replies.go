// Package replies remembers the last thing Claude said in each session so a
// caller that can't hold a live connection — an Alexa skill asking "what did it
// say?" — can fetch it after the fact over HTTP.
//
// It is a passive consumer of the events Hub: it subscribes once at startup and
// caches the Summary (the assistant's closing message) of every Stop event. The
// hook→hub→read-aloud path on mobile already produces that text; this package
// just retains the latest one per session and exposes GET
// /sessions/{id}/last-reply.
package replies

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/Shinyaigeek/aura/server/internal/events"
)

// Reply is the cached last word from a session, plus the short notification
// text that accompanied it.
type Reply struct {
	SessionID string `json:"sessionId"`
	Summary   string `json:"summary"`
	Body      string `json:"body,omitempty"`
}

// Store caches the most recent Stop reply per session id.
type Store struct {
	mu     sync.RWMutex
	latest map[string]Reply
}

// Start subscribes to the hub and returns a Store that keeps itself current in
// the background for the life of the process. The subscription is never
// unsubscribed — the Store lives as long as the server does.
func Start(hub *events.Hub) *Store {
	s := &Store{latest: make(map[string]Reply)}
	ch, _ := hub.Subscribe()
	go func() {
		for ev := range ch {
			// Only Stop events carry an assistant summary worth replaying, and
			// only when we can attribute them to a session.
			if ev.Type != "stop" || ev.SessionID == "" {
				continue
			}
			s.mu.Lock()
			s.latest[ev.SessionID] = Reply{
				SessionID: ev.SessionID,
				Summary:   ev.Summary,
				Body:      ev.Body,
			}
			s.mu.Unlock()
		}
	}()
	return s
}

// Get returns the cached reply for a session and whether one exists.
func (s *Store) Get(id string) (Reply, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.latest[id]
	return r, ok
}

// Handler serves GET /sessions/{id}/last-reply. Returns 404 before the session
// has finished its first turn (nothing cached yet), and the cached Reply as
// JSON once there is one.
func (s *Store) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		reply, ok := s.Get(id)
		if !ok {
			http.Error(w, "no reply yet", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply)
	})
}
