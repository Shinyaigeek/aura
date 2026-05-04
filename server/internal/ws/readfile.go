package ws

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// maxReadFileBytes caps how much we send back to the mobile client. Large
// enough to cover the source files most users want to peek at; small enough
// that a single websocket text frame stays well under the 1 MiB read limit
// configured in handler.go (base64 inflates by ~33% but we send raw utf-8
// here, so the budget is roughly the same).
const maxReadFileBytes = 512 * 1024

type readFileResult struct {
	Path      string
	Content   string
	Size      int64
	Truncated bool
	Binary    bool
}

// readFileForViewer reads a file with a size cap and returns its utf-8
// content suitable for the mobile file-viewer. Binary content (NUL byte or
// invalid utf-8 in the read prefix) returns Binary=true with empty Content
// — the viewer renders a "binary file" placeholder instead.
func readFileForViewer(path string) (*readFileResult, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("path must be absolute: %q", path)
	}
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("path is a directory: %q", clean)
	}

	f, err := os.Open(clean)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	// Read at most maxReadFileBytes+1 so we can tell whether the file is
	// strictly larger than the cap without reading the rest.
	buf, err := io.ReadAll(io.LimitReader(f, maxReadFileBytes+1))
	if err != nil {
		return nil, err
	}
	truncated := false
	if int64(len(buf)) > maxReadFileBytes {
		buf = buf[:maxReadFileBytes]
		truncated = true
	}

	binary := bytes.IndexByte(buf, 0) >= 0 || !utf8.Valid(buf)
	content := ""
	if !binary {
		content = string(buf)
	}

	return &readFileResult{
		Path:      clean,
		Content:   content,
		Size:      info.Size(),
		Truncated: truncated,
		Binary:    binary,
	}, nil
}
