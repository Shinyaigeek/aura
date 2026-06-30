package replies

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Shinyaigeek/aura/server/internal/events"
)

// waitFor polls until cond is true or the deadline passes. Ingestion runs in a
// background goroutine, so reads after a Broadcast are eventually-consistent.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}

func TestStore_CachesLastStopSummary(t *testing.T) {
	hub := events.New()
	store := Start(hub)

	hub.Broadcast(events.Event{Type: "stop", SessionID: "s1", Summary: "first", Body: "ready"})
	hub.Broadcast(events.Event{Type: "stop", SessionID: "s1", Summary: "second", Body: "ready"})

	waitFor(t, func() bool {
		r, ok := store.Get("s1")
		return ok && r.Summary == "second"
	})
}

func TestStore_IgnoresNonStopAndSessionless(t *testing.T) {
	hub := events.New()
	store := Start(hub)

	hub.Broadcast(events.Event{Type: "notification", SessionID: "s1", Body: "waiting"})
	hub.Broadcast(events.Event{Type: "stop", SessionID: "", Summary: "orphan"})
	// A real stop after the noise so we have something to wait on deterministically.
	hub.Broadcast(events.Event{Type: "stop", SessionID: "s2", Summary: "real"})

	waitFor(t, func() bool {
		_, ok := store.Get("s2")
		return ok
	})
	if _, ok := store.Get("s1"); ok {
		t.Fatal("notification event should not be cached")
	}
}

func TestStore_Handler404BeforeFirstReply(t *testing.T) {
	store := Start(events.New())

	req := httptest.NewRequest(http.MethodGet, "/sessions/none/last-reply", nil)
	req.SetPathValue("id", "none")
	rr := httptest.NewRecorder()
	store.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rr.Code)
	}
}

func TestStore_HandlerReturnsCachedReply(t *testing.T) {
	hub := events.New()
	store := Start(hub)
	hub.Broadcast(events.Event{Type: "stop", SessionID: "s1", Summary: "all done", Body: "ready"})
	waitFor(t, func() bool { _, ok := store.Get("s1"); return ok })

	req := httptest.NewRequest(http.MethodGet, "/sessions/s1/last-reply", nil)
	req.SetPathValue("id", "s1")
	rr := httptest.NewRecorder()
	store.Handler().ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	var got Reply
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Summary != "all done" || got.SessionID != "s1" {
		t.Fatalf("got %+v", got)
	}
}
