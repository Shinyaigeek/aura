package ws

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFileForViewerText(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "hello.txt")
	body := "hello\nworld\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readFileForViewer(p)
	if err != nil {
		t.Fatalf("readFileForViewer: %v", err)
	}
	if got.Content != body {
		t.Errorf("content = %q, want %q", got.Content, body)
	}
	if got.Binary {
		t.Errorf("Binary = true, want false")
	}
	if got.Truncated {
		t.Errorf("Truncated = true, want false")
	}
	if got.Size != int64(len(body)) {
		t.Errorf("Size = %d, want %d", got.Size, len(body))
	}
}

func TestReadFileForViewerBinary(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "blob.bin")
	if err := os.WriteFile(p, []byte{0x00, 0x01, 0x02, 0xff}, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readFileForViewer(p)
	if err != nil {
		t.Fatalf("readFileForViewer: %v", err)
	}
	if !got.Binary {
		t.Errorf("Binary = false, want true")
	}
	if got.Content != "" {
		t.Errorf("Content = %q, want empty for binary", got.Content)
	}
}

func TestReadFileForViewerTruncates(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "big.txt")
	big := bytes.Repeat([]byte("a"), maxReadFileBytes+10)
	if err := os.WriteFile(p, big, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readFileForViewer(p)
	if err != nil {
		t.Fatalf("readFileForViewer: %v", err)
	}
	if !got.Truncated {
		t.Errorf("Truncated = false, want true")
	}
	if len(got.Content) != maxReadFileBytes {
		t.Errorf("len(Content) = %d, want %d", len(got.Content), maxReadFileBytes)
	}
}

func TestReadFileForViewerRejectsRelative(t *testing.T) {
	if _, err := readFileForViewer("relative/path"); err == nil {
		t.Fatal("expected error for relative path")
	}
}

func TestReadFileForViewerRejectsDirectory(t *testing.T) {
	tmp := t.TempDir()
	_, err := readFileForViewer(tmp)
	if err == nil || !strings.Contains(err.Error(), "directory") {
		t.Fatalf("expected directory error, got %v", err)
	}
}
