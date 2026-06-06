// Package shares exposes a well-known directory over HTTP so a program
// running on the host — most importantly Claude Code — can hand a file
// (a screenshot, a screen recording, a generated chart) back to the
// mobile user just by dropping it in that directory.
//
// This is deliberately decoupled from aura sessions/tmux: "sharing" is
// nothing more than "put a file in the share dir", which works the same
// whether or not Claude Code is running inside an aura-provisioned pane.
// aura-server injects AURA_SHARE_DIR into every pane it spawns so an
// in-pane process knows where to write, but nothing here depends on that.
//
// Wire shape:
//
//	GET /shares
//	  → 200 application/json
//	    [{"name":"shot.png","size":1234,"modUnix":1700000000,
//	      "mime":"image/png","url":"/shares/shot.png"}, ...]
//	    Newest file first.
//
//	GET /shares/{name}
//	  → 200 (or 206 for range requests) with the file bytes. Content-Type,
//	    Last-Modified and Range support come from http.ServeContent.
//
// Auth is expected to be applied by middleware in the caller.
package shares

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Store is a view over a single directory on disk. The zero value is
// unusable; call NewStore.
type Store struct {
	dir string
}

// NewStore resolves dir (expanding a leading ~), creates it if missing,
// and returns a Store rooted there. The directory is created with 0700 —
// shared files can be anything the user pointed Claude at, so we keep the
// directory itself private to the user running the server.
func NewStore(dir string) (*Store, error) {
	resolved, err := expandHome(dir)
	if err != nil {
		return nil, err
	}
	resolved = filepath.Clean(resolved)
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: resolved}, nil
}

// Dir returns the absolute path being served. Used to inject AURA_SHARE_DIR
// into spawned shells.
func (s *Store) Dir() string { return s.dir }

// item is the wire shape for one entry in the GET /shares listing.
type item struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModUnix int64  `json:"modUnix"`
	Mime    string `json:"mime"`
	URL     string `json:"url"`
}

// ListHandler handles GET /shares: a JSON array of the regular files in the
// share dir, newest first. Dotfiles, subdirectories and the temp files an
// in-flight copy might leave behind are skipped so a half-written share
// never shows up.
func (s *Store) ListHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entries, err := os.ReadDir(s.dir)
		if err != nil {
			http.Error(w, "read share dir: "+err.Error(), http.StatusInternalServerError)
			return
		}

		items := make([]item, 0, len(entries))
		for _, e := range entries {
			name := e.Name()
			if !e.Type().IsRegular() || strings.HasPrefix(name, ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			items = append(items, item{
				Name:    name,
				Size:    info.Size(),
				ModUnix: info.ModTime().Unix(),
				Mime:    mimeType(name),
				URL:     "/shares/" + url.PathEscape(name),
			})
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].ModUnix != items[j].ModUnix {
				return items[i].ModUnix > items[j].ModUnix
			}
			return items[i].Name < items[j].Name
		})

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(items); err != nil {
			slog.Warn("shares: write listing failed", "err", err)
		}
	})
}

// FileHandler handles GET /shares/{name}: streams a single file from the
// share dir. http.ServeContent gives us correct Content-Type, conditional
// requests and HTTP range support (so the mobile client can scrub a video)
// for free.
func (s *Store) FileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		// Reject anything that isn't a bare filename. filepath.Base
		// collapses traversal attempts ("../x", "a/b") to a different
		// string, so a mismatch means the input wasn't a plain name.
		if name == "" || filepath.Base(name) != name {
			http.Error(w, "invalid name", http.StatusBadRequest)
			return
		}

		path := filepath.Join(s.dir, name)
		f, err := os.Open(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer func() { _ = f.Close() }()

		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		http.ServeContent(w, r, name, info.ModTime(), f)
	})
}

// Import copies the file at src into the share dir and returns the absolute
// path of the copy. On a name collision a numeric suffix is appended before
// the extension so an existing share is never clobbered. The copy is atomic
// from a reader's perspective: bytes land in a temp file that is renamed
// into place only once fully written.
func (s *Store) Import(src string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer func() { _ = in.Close() }()

	info, err := in.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular file: %s", src)
	}

	dst := uniquePath(s.dir, filepath.Base(src))

	tmp, err := os.CreateTemp(s.dir, ".aura-share-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	return dst, nil
}

// uniquePath picks an unused path inside dir for name, appending "-1", "-2",
// … before the extension on collision. Mirrors upload.uniquePath.
func uniquePath(dir, name string) string {
	candidate := filepath.Join(dir, name)
	if _, err := os.Lstat(candidate); os.IsNotExist(err) {
		return candidate
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i < 10_000; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := os.Lstat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, os.Getpid(), ext))
}

// mimeType is a best-effort content type from the file extension. Empty
// string when unknown — the client treats anything non-image/non-video as
// a generic download.
func mimeType(name string) string {
	t := mime.TypeByExtension(filepath.Ext(name))
	if t == "" {
		return ""
	}
	// Strip any "; charset=..." parameter; clients only branch on the
	// top-level type.
	if i := strings.IndexByte(t, ';'); i >= 0 {
		t = strings.TrimSpace(t[:i])
	}
	return t
}

// expandHome turns a leading "~" or "~/..." into an absolute path under the
// user's home directory. Other paths are returned unchanged.
func expandHome(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if p == "~" {
			return home, nil
		}
		return filepath.Join(home, p[2:]), nil
	}
	return p, nil
}
