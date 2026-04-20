package ws

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type dirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

// listDirectories returns the subdirectories of path, excluding hidden
// (dot-prefixed) entries and plain files. Symlinks are resolved; a symlink
// that points to a directory is included. path must be absolute.
func listDirectories(path string) ([]dirEntry, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("path must be absolute: %q", path)
	}
	clean := filepath.Clean(path)

	entries, err := os.ReadDir(clean)
	if err != nil {
		return nil, err
	}

	out := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		isDir := e.IsDir()
		if !isDir && e.Type()&os.ModeSymlink != 0 {
			info, err := os.Stat(filepath.Join(clean, name))
			if err == nil && info.IsDir() {
				isDir = true
			}
		}
		if !isDir {
			continue
		}
		out = append(out, dirEntry{Name: name, IsDir: true})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
