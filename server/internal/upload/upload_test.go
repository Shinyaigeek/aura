package upload

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpload_UsesExplicitDest(t *testing.T) {
	dir := t.TempDir()

	rr := doUpload(t, nil, "sess", map[string]string{"dest": dir}, "hello.txt", []byte("hi"))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	var got struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	want := filepath.Join(dir, "hello.txt")
	if got.Path != want {
		t.Errorf("path = %q, want %q", got.Path, want)
	}
	if got.Size != 2 {
		t.Errorf("size = %d, want 2", got.Size)
	}
	assertFileContents(t, want, []byte("hi"))
}

func TestUpload_FallsBackToCwdLookup(t *testing.T) {
	dir := t.TempDir()
	lookup := func(id string) (string, error) {
		if id != "alpha" {
			t.Errorf("cwdLookup called with id=%q, want %q", id, "alpha")
		}
		return dir, nil
	}

	rr := doUpload(t, lookup, "alpha", nil, "report.pdf", []byte("%PDF-pretend"))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	assertFileContents(t, filepath.Join(dir, "report.pdf"), []byte("%PDF-pretend"))
}

func TestUpload_CollisionsGetSuffix(t *testing.T) {
	dir := t.TempDir()
	// Seed a file that will collide.
	if err := os.WriteFile(filepath.Join(dir, "photo.jpg"), []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}

	rr := doUpload(t, nil, "sess", map[string]string{"dest": dir}, "photo.jpg", []byte("new-upload"))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)

	want := filepath.Join(dir, "photo-1.jpg")
	if got.Path != want {
		t.Errorf("path = %q, want %q", got.Path, want)
	}
	assertFileContents(t, want, []byte("new-upload"))
	// Original untouched.
	assertFileContents(t, filepath.Join(dir, "photo.jpg"), []byte("existing"))
}

func TestUpload_FilenameOverride(t *testing.T) {
	dir := t.TempDir()
	rr := doUpload(
		t, nil, "sess",
		map[string]string{"dest": dir, "filename": "renamed.md"},
		"original.txt",
		[]byte("content"),
	)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	assertFileContents(t, filepath.Join(dir, "renamed.md"), []byte("content"))
}

func TestUpload_MissingFilePart(t *testing.T) {
	dir := t.TempDir()
	// Build a multipart body with only a dest field.
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	_ = mw.WriteField("dest", dir)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/sessions/sess/upload", body)
	req.SetPathValue("id", "sess")
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	NewHandler(nil).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_RejectsRelativeDest(t *testing.T) {
	rr := doUpload(t, nil, "sess", map[string]string{"dest": "relative/path"}, "x.txt", []byte("y"))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_RejectsFilenameTraversal(t *testing.T) {
	dir := t.TempDir()
	// Filename with path separators should be reduced to its base via
	// filepath.Base — request should still succeed but land as "evil.sh"
	// inside dir, not one level up.
	rr := doUpload(t, nil, "sess",
		map[string]string{"dest": dir, "filename": "../evil.sh"},
		"whatever", []byte("rm -rf /"),
	)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil.sh")); err == nil {
		t.Fatal("file escaped dest directory")
	}
	assertFileContents(t, filepath.Join(dir, "evil.sh"), []byte("rm -rf /"))
}

func TestUpload_TooLarge(t *testing.T) {
	dir := t.TempDir()

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	_ = mw.WriteField("dest", dir)
	fw, err := mw.CreateFormFile("file", "big.bin")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(bytes.Repeat([]byte("A"), 2048))
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/sessions/sess/upload", body)
	req.SetPathValue("id", "sess")
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	NewHandlerWithLimit(nil, 1024).ServeHTTP(rr, req)

	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_MissingSessionID(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/sessions//upload", strings.NewReader(""))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rr := httptest.NewRecorder()
	NewHandler(nil).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestUpload_NonMultipart(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/sessions/sess/upload", strings.NewReader("{}"))
	req.SetPathValue("id", "sess")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	NewHandler(nil).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "multipart") {
		t.Errorf("body = %q, want to mention 'multipart'", rr.Body.String())
	}
}

// ── helpers ──────────────────────────────────────────────────────────

// doUpload issues a well-formed multipart POST against a handler backed by the
// given cwd lookup. fields is ordered as (dest, filename) if present; the file
// part is written last so the handler can honor dest when it begins streaming.
func doUpload(
	t *testing.T,
	lookup CwdLookup,
	sessionID string,
	fields map[string]string,
	filename string,
	content []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	// Dest/filename must land before the file part in the multipart stream
	// — the handler is single-pass.
	if v, ok := fields["dest"]; ok {
		if err := mw.WriteField("dest", v); err != nil {
			t.Fatal(err)
		}
	}
	if v, ok := fields["filename"]; ok {
		if err := mw.WriteField("filename", v); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(fw, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/sessions/"+sessionID+"/upload", body)
	req.SetPathValue("id", sessionID)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	NewHandler(lookup).ServeHTTP(rr, req)
	return rr
}

func assertFileContents(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s = %q, want %q", path, got, want)
	}
}
