// Package upload exposes a multipart endpoint for pushing files from the
// mobile app into the filesystem of the host running aura-server.
//
// Wire shape:
//
//	POST /sessions/{id}/upload
//	Content-Type: multipart/form-data
//	Fields:
//	  dest      (optional, text): absolute directory to write into. If
//	            absent, defaults to the current working directory of the
//	            session's tmux pane.
//	  filename  (optional, text): override the file part's filename.
//	  file      (required, binary): the file payload.
//
// Fields MUST arrive in the order above (text fields before the file part)
// — the handler streams straight from `file` to disk without buffering, so
// `dest` is only consulted once at the point the file part starts.
//
// Response on success:
//
//	200 OK
//	Content-Type: application/json
//	{"path":"/abs/path/to/saved/file","size":12345}
package upload

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// CwdLookup resolves an aura session id to the cwd of its tmux pane. Broken
// out as an interface so tests don't have to shell out to tmux.
type CwdLookup func(sessionID string) (string, error)

// DefaultMaxBytes is the default per-request payload cap. Chosen so a phone
// can push a 4K photo or a long scanned PDF without tuning, but large enough
// media (long video) trips it so the server doesn't silently fill a disk.
const DefaultMaxBytes int64 = 512 << 20

// NewHandler returns an http.Handler for POST /sessions/{id}/upload.
func NewHandler(cwdLookup CwdLookup) http.Handler {
	return NewHandlerWithLimit(cwdLookup, DefaultMaxBytes)
}

// NewHandlerWithLimit is NewHandler with an explicit byte cap, exposed for
// tests that need to exercise the 413 path without allocating 500 MiB.
func NewHandlerWithLimit(cwdLookup CwdLookup, maxBytes int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing session id", http.StatusBadRequest)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

		mr, err := r.MultipartReader()
		if err != nil {
			http.Error(w, "expected multipart/form-data: "+err.Error(), http.StatusBadRequest)
			return
		}

		var (
			dest     string
			filename string
			saved    string
			size     int64
		)

		for {
			part, err := mr.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				writeMultipartErr(w, "read part", err)
				return
			}

			switch part.FormName() {
			case "dest":
				v, err := readSmallField(part)
				if err != nil {
					writeMultipartErr(w, "read dest", err)
					return
				}
				dest = v
			case "filename":
				v, err := readSmallField(part)
				if err != nil {
					writeMultipartErr(w, "read filename", err)
					return
				}
				filename = v
			case "file":
				if saved != "" {
					drainPart(part)
					http.Error(w, "multiple file parts", http.StatusBadRequest)
					return
				}
				fn := filename
				if fn == "" {
					fn = part.FileName()
				}
				resolvedDest, err := resolveDest(dest, id, cwdLookup)
				if err != nil {
					drainPart(part)
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				path, n, err := saveStream(resolvedDest, fn, part)
				if err != nil {
					var mbe *http.MaxBytesError
					if errors.As(err, &mbe) {
						http.Error(w, "upload too large", http.StatusRequestEntityTooLarge)
						return
					}
					http.Error(w, "save: "+err.Error(), http.StatusInternalServerError)
					return
				}
				saved = path
				size = n
			default:
				drainPart(part)
			}
		}

		if saved == "" {
			http.Error(w, "missing file part", http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"path": saved,
			"size": size,
		}); err != nil {
			slog.Warn("upload: write response failed", "err", err)
		}
	})
}

// readSmallField drains a text form field, capped at 4 KiB. Larger values
// almost certainly indicate a misuse (dest should be a path, filename a basename).
func readSmallField(part io.ReadCloser) (string, error) {
	defer func() { _ = part.Close() }()
	b, err := io.ReadAll(io.LimitReader(part, 4096))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func drainPart(part io.ReadCloser) {
	_, _ = io.Copy(io.Discard, part)
	_ = part.Close()
}

// writeMultipartErr turns a parse error into the right status code. A
// MaxBytesError can surface here (not just from Copy) if the entire request
// envelope is already over the limit.
func writeMultipartErr(w http.ResponseWriter, prefix string, err error) {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		http.Error(w, "upload too large", http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, prefix+": "+err.Error(), http.StatusBadRequest)
}

// resolveDest returns the absolute directory the upload should land in.
// Precedence: explicit dest form field, then the tmux pane's cwd for the
// session. Rejects relative paths — the client must tell us somewhere real.
func resolveDest(dest, sessionID string, cwdLookup CwdLookup) (string, error) {
	if dest == "" {
		if cwdLookup == nil {
			return "", errors.New("no dest provided and no cwd lookup configured")
		}
		cwd, err := cwdLookup(sessionID)
		if err != nil {
			return "", fmt.Errorf("resolve session cwd: %w", err)
		}
		if cwd == "" {
			return "", errors.New("session has no cwd; is tmux running?")
		}
		dest = cwd
	}
	if !filepath.IsAbs(dest) {
		return "", fmt.Errorf("dest must be absolute: %q", dest)
	}
	return filepath.Clean(dest), nil
}

// saveStream writes src into dir under a unique name derived from filename,
// atomically via tempfile + rename. Returns the final absolute path and the
// byte count written.
func saveStream(dir, filename string, src io.Reader) (string, int64, error) {
	base, err := sanitizeFilename(filename)
	if err != nil {
		return "", 0, err
	}

	info, err := os.Stat(dir)
	if err != nil {
		return "", 0, fmt.Errorf("dest: %w", err)
	}
	if !info.IsDir() {
		return "", 0, fmt.Errorf("dest is not a directory: %s", dir)
	}

	finalPath := uniquePath(dir, base)

	tmp, err := os.CreateTemp(dir, ".aura-upload-*")
	if err != nil {
		return "", 0, fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()

	n, copyErr := io.Copy(tmp, src)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return "", 0, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return "", 0, closeErr
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", 0, fmt.Errorf("rename: %w", err)
	}
	return finalPath, n, nil
}

// sanitizeFilename strips any path components and rejects the obviously-bad
// cases. We deliberately keep this permissive (no character class whitelist)
// because the token holder already has full shell access via the WS; path
// traversal is the only attack vector that doesn't already require the
// attacker to have won.
func sanitizeFilename(name string) (string, error) {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return "", fmt.Errorf("invalid filename: %q", name)
	}
	if strings.ContainsRune(base, 0) {
		return "", fmt.Errorf("invalid filename: contains NUL")
	}
	return base, nil
}

// uniquePath picks an unused path inside dir for filename, appending "-1",
// "-2", … before the extension on collision.
func uniquePath(dir, filename string) string {
	candidate := filepath.Join(dir, filename)
	if _, err := os.Lstat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)
	for i := 1; i < 10_000; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := os.Lstat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
	// Degenerate fallback: if ten thousand sibling files exist we've got
	// bigger problems, but don't outright fail.
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, os.Getpid(), ext))
}
