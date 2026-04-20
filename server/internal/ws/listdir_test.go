package ws

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDirectories(t *testing.T) {
	tmp := t.TempDir()

	for _, name := range []string{"src", "tests", ".hidden", "zzz"} {
		if err := os.Mkdir(filepath.Join(tmp, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	for _, name := range []string{"README.md", ".env"} {
		if err := os.WriteFile(filepath.Join(tmp, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	got, err := listDirectories(tmp)
	if err != nil {
		t.Fatalf("listDirectories: %v", err)
	}

	wantNames := []string{"src", "tests", "zzz"}
	if len(got) != len(wantNames) {
		t.Fatalf("got %d entries, want %d: %+v", len(got), len(wantNames), got)
	}
	for i, n := range wantNames {
		if got[i].Name != n {
			t.Errorf("entries[%d].Name = %q, want %q", i, got[i].Name, n)
		}
		if !got[i].IsDir {
			t.Errorf("entries[%d].IsDir = false, want true", i)
		}
	}
}

func TestListDirectoriesRejectsRelative(t *testing.T) {
	if _, err := listDirectories("relative/path"); err == nil {
		t.Fatal("expected error for relative path")
	}
}

func TestListDirectoriesErrorsOnMissing(t *testing.T) {
	if _, err := listDirectories(filepath.Join(os.TempDir(), "nonexistent-aura-test-dir-xyz123")); err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestListDirectoriesResolvesDirSymlink(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "actual")
	link := filepath.Join(tmp, "alias")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	got, err := listDirectories(tmp)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range got {
		names[e.Name] = true
	}
	if !names["actual"] {
		t.Errorf("missing 'actual' dir: %+v", got)
	}
	if !names["alias"] {
		t.Errorf("missing 'alias' symlinked dir: %+v", got)
	}
}
