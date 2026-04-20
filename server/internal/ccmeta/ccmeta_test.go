package ccmeta

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractFirstUserMessage_StringContent(t *testing.T) {
	path := writeTranscript(t, `{"type":"system","message":{"content":"boot"}}
{"type":"user","message":{"content":"hello aura"}}
{"type":"assistant","message":{"content":"hi!"}}
`)
	got, err := extractFirstUserMessage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello aura" {
		t.Errorf("want %q, got %q", "hello aura", got)
	}
}

func TestExtractFirstUserMessage_ArrayContent(t *testing.T) {
	path := writeTranscript(t,
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"x"},{"type":"text","text":"the actual prompt"}]}}
`)
	got, err := extractFirstUserMessage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "the actual prompt" {
		t.Errorf("want %q, got %q", "the actual prompt", got)
	}
}

func TestExtractFirstUserMessage_NoUser(t *testing.T) {
	path := writeTranscript(t, `{"type":"assistant","message":{"content":"preamble"}}
`)
	got, err := extractFirstUserMessage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("want empty, got %q", got)
	}
}

func TestExtractFirstUserMessage_SkipsEmptyUser(t *testing.T) {
	path := writeTranscript(t, `{"type":"user","message":{"content":""}}
{"type":"user","message":{"content":"   "}}
{"type":"user","message":{"content":"real one"}}
`)
	got, err := extractFirstUserMessage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "real one" {
		t.Errorf("want %q, got %q", "real one", got)
	}
}

func TestExtractFirstUserMessage_BoundedByHeadCap(t *testing.T) {
	// Pad with 70 KiB of garbage, then a user message — extractor should give
	// up inside the head cap and return empty.
	var sb strings.Builder
	for sb.Len() < 70<<10 {
		sb.WriteString("{\"type\":\"noise\",\"message\":{\"content\":\"")
		sb.WriteString(strings.Repeat("x", 120))
		sb.WriteString("\"}}\n")
	}
	sb.WriteString(`{"type":"user","message":{"content":"too late"}}` + "\n")
	path := writeTranscript(t, sb.String())

	got, err := extractFirstUserMessage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("expected no title past head cap, got %q", got)
	}
}

func TestCache_UsesMtimeToInvalidate(t *testing.T) {
	path := writeTranscript(t, `{"type":"user","message":{"content":"first"}}`+"\n")
	c := NewCache()

	got, _, err := c.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "first" {
		t.Fatalf("want %q, got %q", "first", got)
	}

	// Rewrite with different content + bumped mtime.
	if err := os.WriteFile(path, []byte(`{"type":"user","message":{"content":"second"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bumpMtime(t, path)

	got, _, err = c.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "second" {
		t.Errorf("cache did not invalidate on mtime change: got %q", got)
	}
}

func TestTruncateRunes(t *testing.T) {
	// 10 CJK runes → 30 bytes; runes-based truncate must count codepoints.
	src := "あいうえおかきくけこ"
	if got := truncateRunes(src, 5); got != "あいうえお…" {
		t.Errorf("rune truncate: got %q", got)
	}
	if got := truncateRunes(src, 100); got != src {
		t.Errorf("no-op truncate: got %q", got)
	}
}

func TestEncodeProjectDir(t *testing.T) {
	if got := encodeProjectDir("/home/alice/project"); got != "-home-alice-project" {
		t.Errorf("encode: got %q", got)
	}
}

// Helpers

func writeTranscript(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func bumpMtime(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	later := info.ModTime().Add(5 * 1_000_000_000) // 5 s
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
}
