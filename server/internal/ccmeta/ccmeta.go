// Package ccmeta extracts session metadata (title, cwd) from Claude Code's
// on-disk transcripts, so aura can surface something more useful than raw
// session ids in the mobile tab bar and push-notification bodies.
//
// Claude Code persists every session as a JSONL file under
// `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. The first `type:"user"`
// line's content is the session's natural title — it's whatever the user
// typed first. We read only a bounded prefix of the file (64 KiB) so huge
// transcripts don't turn a metadata lookup into a disk-thrash, and cache by
// `(path, size, mtime)` so polling the same file is ~free.
//
// This package is a pure, stateless extractor aside from the cache; the
// handler layer owns the tmux → cwd → transcript mapping.
package ccmeta

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// headByteCap bounds how much of a transcript file we read looking for the
// first user message. Matches cmux's choice; the first user prompt is almost
// always in the first handful of lines.
const headByteCap = 64 << 10

// titleRuneCap trims the derived title so it fits sanely in a tab pill or a
// push-notification body. Runes, not bytes, because CJK / emoji.
const titleRuneCap = 80

// Meta is what the server surfaces for a given session.
type Meta struct {
	Title        string    `json:"title,omitempty"`
	Cwd          string    `json:"cwd,omitempty"`
	TranscriptAt time.Time `json:"transcriptAt,omitempty"`
}

// Cache memoizes Read results by (path, size, mtime). A changed file
// invalidates its entry on the next lookup without any explicit eviction.
type Cache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	mtime time.Time
	size  int64
	title string
}

func NewCache() *Cache {
	return &Cache{entries: make(map[string]cacheEntry)}
}

// Read extracts the title from a transcript file. Returns an empty title
// (not an error) when the file has no user message in its head.
func (c *Cache) Read(path string) (string, time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", time.Time{}, err
	}

	c.mu.Lock()
	if e, ok := c.entries[path]; ok && e.mtime.Equal(info.ModTime()) && e.size == info.Size() {
		c.mu.Unlock()
		return e.title, info.ModTime(), nil
	}
	c.mu.Unlock()

	title, err := extractFirstUserMessage(path)
	if err != nil {
		return "", time.Time{}, err
	}
	title = truncateRunes(title, titleRuneCap)

	c.mu.Lock()
	c.entries[path] = cacheEntry{mtime: info.ModTime(), size: info.Size(), title: title}
	c.mu.Unlock()

	return title, info.ModTime(), nil
}

// LookupByCwd returns metadata for the most recently modified Claude Code
// transcript associated with cwd, or an empty Meta if none exists.
func (c *Cache) LookupByCwd(cwd string) (Meta, error) {
	if cwd == "" {
		return Meta{}, nil
	}
	path, modTime, err := latestTranscriptForCwd(cwd)
	if err != nil {
		return Meta{}, err
	}
	if path == "" {
		return Meta{Cwd: cwd}, nil
	}
	title, _, err := c.Read(path)
	if err != nil {
		return Meta{}, fmt.Errorf("read transcript %s: %w", path, err)
	}
	return Meta{Title: title, Cwd: cwd, TranscriptAt: modTime}, nil
}

// ReadPath is the same as Read but returns a full Meta, with Cwd left blank
// when the caller hasn't established it. Useful from the stop-hook path
// which receives transcript_path directly from CC.
func (c *Cache) ReadPath(path string) (Meta, error) {
	title, modTime, err := c.Read(path)
	if err != nil {
		return Meta{}, err
	}
	return Meta{Title: title, TranscriptAt: modTime}, nil
}

// latestTranscriptForCwd scans ~/.claude/projects/<encoded-cwd>/*.jsonl and
// returns the most recently modified entry.
func latestTranscriptForCwd(cwd string) (string, time.Time, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", time.Time{}, errors.New("cannot resolve home dir")
	}
	dir := filepath.Join(home, ".claude", "projects", encodeProjectDir(cwd))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", time.Time{}, nil
		}
		return "", time.Time{}, err
	}

	type candidate struct {
		path    string
		modTime time.Time
	}
	cands := make([]candidate, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		cands = append(cands, candidate{
			path:    filepath.Join(dir, e.Name()),
			modTime: info.ModTime(),
		})
	}
	if len(cands) == 0 {
		return "", time.Time{}, nil
	}
	sort.Slice(cands, func(i, j int) bool {
		return cands[i].modTime.After(cands[j].modTime)
	})
	return cands[0].path, cands[0].modTime, nil
}

// encodeProjectDir mirrors Claude Code's on-disk convention: slashes in the
// absolute cwd are replaced with hyphens. Ambiguous in the reverse direction
// but unambiguous forward, which is the direction we need.
func encodeProjectDir(cwd string) string {
	return strings.ReplaceAll(cwd, "/", "-")
}

// extractFirstUserMessage parses the head of a JSONL transcript and returns
// the content of the first `type:"user"` message. No match → empty string.
func extractFirstUserMessage(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	r := bufio.NewReaderSize(f, 32<<10)
	var consumed int
	for consumed < headByteCap {
		line, readErr := r.ReadBytes('\n')
		consumed += len(line)
		if len(line) > 0 {
			if title, ok := parseUserLine(line); ok {
				return title, nil
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return "", nil
			}
			return "", readErr
		}
	}
	return "", nil
}

// parseUserLine decodes one JSONL line; returns (text, true) only when the
// line is a user message with non-empty content.
func parseUserLine(line []byte) (string, bool) {
	var e struct {
		Type    string `json:"type"`
		Message struct {
			// Content can be either a string (most common) or an array of
			// content parts (when the transcript includes tool results, images,
			// etc.). Unmarshal as `any` and branch.
			Content any `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &e); err != nil {
		return "", false
	}
	if e.Type != "user" {
		return "", false
	}
	text := extractText(e.Message.Content)
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	return text, true
}

// extractText collapses a user message's content value to its first visible
// text fragment. Strings are returned as-is; arrays are scanned for a text
// part. Everything else returns empty, so non-text first messages (e.g. a
// tool result) don't accidentally become a session title.
func extractText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		for _, part := range c {
			m, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] != "text" {
				continue
			}
			if t, ok := m["text"].(string); ok && t != "" {
				return t
			}
		}
	}
	return ""
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "…"
}
