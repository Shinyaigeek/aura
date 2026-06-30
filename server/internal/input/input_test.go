package input

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newReq(id, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/sessions/"+id+"/input", bytes.NewBufferString(body))
	req.SetPathValue("id", id)
	return req
}

func TestInput_SendsTextToLiveSession(t *testing.T) {
	var gotID, gotText string
	send := func(id, text string) error { gotID, gotText = id, text; return nil }
	exists := func(string) (bool, error) { return true, nil }

	rr := httptest.NewRecorder()
	NewHandler(send, exists).ServeHTTP(rr, newReq("s1", `{"text":"  hello world  "}`))

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if gotID != "s1" || gotText != "hello world" {
		t.Fatalf("got id=%q text=%q", gotID, gotText)
	}
}

func TestInput_404WhenSessionMissing(t *testing.T) {
	sent := false
	send := func(string, string) error { sent = true; return nil }
	exists := func(string) (bool, error) { return false, nil }

	rr := httptest.NewRecorder()
	NewHandler(send, exists).ServeHTTP(rr, newReq("s1", `{"text":"hi"}`))

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rr.Code)
	}
	if sent {
		t.Fatal("must not send into a dead session")
	}
}

func TestInput_RejectsEmptyText(t *testing.T) {
	send := func(string, string) error { t.Fatal("should not send"); return nil }
	exists := func(string) (bool, error) { return true, nil }

	for _, body := range []string{`{"text":""}`, `{"text":"   "}`, `{}`} {
		rr := httptest.NewRecorder()
		NewHandler(send, exists).ServeHTTP(rr, newReq("s1", body))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("body=%q status=%d", body, rr.Code)
		}
	}
}
