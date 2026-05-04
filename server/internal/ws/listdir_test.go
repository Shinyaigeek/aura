package ws

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListEntriesDirsOnly(t *testing.T) {
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

	got, err := listEntries(tmp, true)
	if err != nil {
		t.Fatalf("listEntries: %v", err)
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

func TestListEntriesIncludesFiles(t *testing.T) {
	tmp := t.TempDir()

	if err := os.Mkdir(filepath.Join(tmp, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".hidden"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := listEntries(tmp, false)
	if err != nil {
		t.Fatalf("listEntries: %v", err)
	}
	// dirs first, then files; hidden excluded.
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(got), got)
	}
	if got[0].Name != "src" || !got[0].IsDir {
		t.Errorf("entries[0] = %+v, want src/dir", got[0])
	}
	if got[1].Name != "README.md" || got[1].IsDir {
		t.Errorf("entries[1] = %+v, want README.md/file", got[1])
	}
	if got[1].Size != 5 {
		t.Errorf("entries[1].Size = %d, want 5", got[1].Size)
	}
}

func TestListEntriesRejectsRelative(t *testing.T) {
	if _, err := listEntries("relative/path", true); err == nil {
		t.Fatal("expected error for relative path")
	}
}

func TestListEntriesErrorsOnMissing(t *testing.T) {
	if _, err := listEntries(filepath.Join(os.TempDir(), "nonexistent-aura-test-dir-xyz123"), true); err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestListEntriesResolvesDirSymlink(t *testing.T) {
	tmp := t.TempDir()
	target := filepath.Join(tmp, "actual")
	link := filepath.Join(tmp, "alias")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	got, err := listEntries(tmp, true)
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
