package difit

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// CwdLookup resolves a session id to the cwd of its tmux pane. Same shape as
// the upload package — broken out so tests don't have to shell out to tmux.
type CwdLookup func(sessionID string) (string, error)

type startResponse struct {
	Port int `json:"port"`
}

// NewStartHandler handles POST /sessions/{id}/difit. It (re)starts difit in
// the session's pane cwd and returns the chosen port.
func NewStartHandler(mgr *Manager, cwd CwdLookup) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		dir, err := cwd(id)
		if err != nil {
			slog.Error("difit start: cwd lookup failed", "session", id, "err", err)
			http.Error(w, "cwd lookup failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		p, err := mgr.Start(id, dir)
		if err != nil {
			slog.Error("difit start failed", "session", id, "err", err)
			http.Error(w, "difit start failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(startResponse{Port: p.Port})
	})
}

// NewStopHandler handles DELETE /sessions/{id}/difit.
func NewStopHandler(mgr *Manager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}
		mgr.Stop(id)
		w.WriteHeader(http.StatusNoContent)
	})
}
