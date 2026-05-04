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
	Size  int64  `json:"size,omitempty"`
}

// listEntries returns the entries of path, excluding hidden (dot-prefixed)
// names. Symlinks are resolved; a symlink to a directory counts as a
// directory. When dirsOnly is true, regular files are filtered out (this
// preserves the original "directory picker" behavior used by the upload
// destination flow). path must be absolute. Results are sorted with
// directories first, then alphabetically.
func listEntries(path string, dirsOnly bool) ([]dirEntry, error) {
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
		var size int64
		if e.Type()&os.ModeSymlink != 0 {
			info, err := os.Stat(filepath.Join(clean, name))
			if err != nil {
				continue
			}
			isDir = info.IsDir()
			if !isDir {
				size = info.Size()
			}
		} else if !isDir {
			info, err := e.Info()
			if err == nil {
				size = info.Size()
			}
		}
		if dirsOnly && !isDir {
			continue
		}
		out = append(out, dirEntry{Name: name, IsDir: isDir, Size: size})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}
