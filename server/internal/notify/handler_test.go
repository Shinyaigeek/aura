package notify

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Shinyaigeek/aura/server/internal/ccmeta"
	"github.com/Shinyaigeek/aura/server/internal/events"
)

type fakeHub struct {
	mu  sync.Mutex
	got []events.Event
}

func (f *fakeHub) Broadcast(e events.Event) {
	f.mu.Lock()
	f.got = append(f.got, e)
	f.mu.Unlock()
}

func (f *fakeHub) events() []events.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]events.Event, len(f.got))
	copy(out, f.got)
	return out
}

type stubTitles struct {
	byPath map[string]ccmeta.Meta
}

func (s stubTitles) LookupByCwd(string) (ccmeta.Meta, error) { return ccmeta.Meta{}, nil }
func (s stubTitles) ReadPath(p string) (ccmeta.Meta, error) {
	return s.byPath[p], nil
}

func TestStopHookHandler_BroadcastsWithSessionFromHeader(t *testing.T) {
	hub := &fakeHub{}
	h := NewStopHookHandler(hub, nil)

	req := httptest.NewRequest(http.MethodPost, "/hooks/stop", bytes.NewBufferString(`{}`))
	req.Header.Set("X-Aura-Session-Id", "42")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	got := hub.events()
	if len(got) != 1 {
		t.Fatalf("want 1 event, got %d", len(got))
	}
	if got[0].Type != "stop" || got[0].SessionID != "42" {
		t.Errorf("unexpected event: %+v", got[0])
	}
	if got[0].Body == "" {
		t.Errorf("empty body — should fall back to a sensible default")
	}
}

func TestStopHookHandler_PrefersTranscriptTitleOverDefault(t *testing.T) {
	titles := stubTitles{byPath: map[string]ccmeta.Meta{
		"/tmp/transcript.jsonl": {Title: "fix the auth bug"},
	}}
	hub := &fakeHub{}
	h := NewStopHookHandler(hub, titles)

	body := `{"transcript_path":"/tmp/transcript.jsonl"}`
	req := httptest.NewRequest(http.MethodPost, "/hooks/stop", bytes.NewBufferString(body))
	req.Header.Set("X-Aura-Session-Id", "1")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	got := hub.events()
	if len(got) != 1 || got[0].Body != "fix the auth bug" {
		t.Errorf("transcript title not used: %+v", got)
	}
}

func TestStopHookHandler_FallsBackToBodyField(t *testing.T) {
	hub := &fakeHub{}
	h := NewStopHookHandler(hub, nil)

	req := httptest.NewRequest(
		http.MethodPost,
		"/hooks/stop",
		bytes.NewBufferString(`{"sessionId":"abc","title":"My title","body":"explicit body"}`),
	)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	got := hub.events()
	if len(got) != 1 {
		t.Fatalf("want 1 event, got %d", len(got))
	}
	if got[0].Title != "My title" || got[0].Body != "explicit body" || got[0].SessionID != "abc" {
		t.Errorf("unexpected event: %+v", got[0])
	}
}

func TestStopHookHandler_RejectsInvalidJSON(t *testing.T) {
	hub := &fakeHub{}
	h := NewStopHookHandler(hub, nil)

	req := httptest.NewRequest(http.MethodPost, "/hooks/stop", bytes.NewBufferString(`not json`))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status=%d, want 400", rr.Code)
	}
	if len(hub.events()) != 0 {
		t.Errorf("invalid request should not broadcast")
	}
}

func TestNotificationHookHandler_ForwardsMessageAsBody(t *testing.T) {
	hub := &fakeHub{}
	h := NewNotificationHookHandler(hub)

	body := `{"session_id":"x","message":"Claude needs your permission to use Bash"}`
	req := httptest.NewRequest(http.MethodPost, "/hooks/notification", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d", rr.Code)
	}
	got := hub.events()
	if len(got) != 1 {
		t.Fatalf("want 1 event, got %d", len(got))
	}
	if got[0].Type != "notification" || got[0].Body != "Claude needs your permission to use Bash" {
		t.Errorf("unexpected event: %+v", got[0])
	}
}

func TestNotificationHookHandler_PrefersHeaderSessionID(t *testing.T) {
	hub := &fakeHub{}
	h := NewNotificationHookHandler(hub)

	body := `{"session_id":"body-id","message":"test"}`
	req := httptest.NewRequest(http.MethodPost, "/hooks/notification", bytes.NewBufferString(body))
	req.Header.Set("X-Aura-Session-Id", "header-id")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	got := hub.events()
	if len(got) != 1 || got[0].SessionID != "header-id" {
		t.Errorf("want header session id wins: %+v", got)
	}
}

func TestNotificationHookHandler_DefaultBodyWhenMessageMissing(t *testing.T) {
	hub := &fakeHub{}
	h := NewNotificationHookHandler(hub)

	req := httptest.NewRequest(http.MethodPost, "/hooks/notification", bytes.NewBufferString(`{}`))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	got := hub.events()
	if len(got) != 1 || got[0].Body == "" {
		t.Errorf("expected default body, got %+v", got)
	}
}
