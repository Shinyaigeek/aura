package shares

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

// writeFile creates a file in the store dir with a specific mtime so list
// ordering is deterministic.
func writeFile(t *testing.T, s *Store, name, body string, mod time.Time) {
	t.Helper()
	p := filepath.Join(s.Dir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
}

func TestList_NewestFirstAndShape(t *testing.T) {
	s := newStore(t)
	base := time.Unix(1_700_000_000, 0)
	writeFile(t, s, "old.txt", "old", base)
	writeFile(t, s, "new.png", "newpng", base.Add(time.Hour))
	// Things that must be skipped:
	writeFile(t, s, ".hidden", "x", base)
	if err := os.Mkdir(filepath.Join(s.Dir(), "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	rr := httptest.NewRecorder()
	s.ListHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/shares", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}

	var got []item
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v; body=%s", err, rr.Body.String())
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (dotfile + subdir skipped); got %+v", len(got), got)
	}
	if got[0].Name != "new.png" {
		t.Errorf("first = %q, want new.png (newest first)", got[0].Name)
	}
	if got[0].Mime != "image/png" {
		t.Errorf("mime = %q, want image/png", got[0].Mime)
	}
	if got[0].URL != "/shares/new.png" {
		t.Errorf("url = %q, want /shares/new.png", got[0].URL)
	}
	if got[0].Size != int64(len("newpng")) {
		t.Errorf("size = %d, want %d", got[0].Size, len("newpng"))
	}
}

// fileServer wires FileHandler behind a mux so r.PathValue("name") resolves.
func fileServer(s *Store) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /shares/{name}", s.FileHandler())
	return mux
}

func TestFile_ServesBytes(t *testing.T) {
	s := newStore(t)
	writeFile(t, s, "hello.txt", "hi there", time.Unix(1_700_000_000, 0))

	rr := httptest.NewRecorder()
	fileServer(s).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/shares/hello.txt", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if rr.Body.String() != "hi there" {
		t.Errorf("body = %q, want %q", rr.Body.String(), "hi there")
	}
}

func TestFile_RangeRequest(t *testing.T) {
	s := newStore(t)
	writeFile(t, s, "clip.mp4", "0123456789", time.Unix(1_700_000_000, 0))

	req := httptest.NewRequest(http.MethodGet, "/shares/clip.mp4", nil)
	req.Header.Set("Range", "bytes=0-3")
	rr := httptest.NewRecorder()
	fileServer(s).ServeHTTP(rr, req)

	if rr.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rr.Code)
	}
	if rr.Body.String() != "0123" {
		t.Errorf("body = %q, want %q", rr.Body.String(), "0123")
	}
}

func TestFile_Missing(t *testing.T) {
	s := newStore(t)
	rr := httptest.NewRecorder()
	fileServer(s).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/shares/nope.txt", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestFile_RejectsTraversal(t *testing.T) {
	s := newStore(t)
	// Seed a secret outside the share dir to prove it stays unreachable.
	secret := filepath.Join(filepath.Dir(s.Dir()), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOPSECRET"), 0o644); err != nil {
		t.Fatalf("seed secret: %v", err)
	}

	// Each of these decodes to a name with a path separator or traversal,
	// which filepath.Base would change — so FileHandler must 400.
	for _, target := range []string{
		"/shares/..%2Fsecret.txt",
		"/shares/..%2F..%2Fetc%2Fpasswd",
		"/shares/sub%2Ffile.txt",
	} {
		rr := httptest.NewRecorder()
		fileServer(s).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, target, nil))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body=%s", target, rr.Code, rr.Body.String())
		}
	}
}

func TestImport_CopiesAndAvoidsCollision(t *testing.T) {
	s := newStore(t)
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "pic.png")
	if err := os.WriteFile(src, []byte("PNGDATA"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}

	first, err := s.Import(src)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if first != filepath.Join(s.Dir(), "pic.png") {
		t.Errorf("first dst = %q, want pic.png in dir", first)
	}
	if b, _ := os.ReadFile(first); string(b) != "PNGDATA" {
		t.Errorf("first contents = %q, want PNGDATA", b)
	}

	// Original must be left untouched and a second import must not clobber.
	second, err := s.Import(src)
	if err != nil {
		t.Fatalf("import 2: %v", err)
	}
	if second == first {
		t.Errorf("second dst = %q, want a suffixed name", second)
	}
	if second != filepath.Join(s.Dir(), "pic-1.png") {
		t.Errorf("second dst = %q, want pic-1.png", second)
	}
	if _, err := os.Stat(src); err != nil {
		t.Errorf("source removed/altered: %v", err)
	}
}

func TestNewStore_ExpandsHomeAndCreates(t *testing.T) {
	// Point HOME at a temp dir and ask for "~/sub/share".
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	s, err := NewStore("~/sub/share")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	want := filepath.Join(tmp, "sub", "share")
	if s.Dir() != want {
		t.Errorf("dir = %q, want %q", s.Dir(), want)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Errorf("dir not created: err=%v", err)
	}
}
