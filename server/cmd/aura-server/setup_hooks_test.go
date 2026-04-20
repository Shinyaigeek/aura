package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPatchStopHooks_EmptySettings(t *testing.T) {
	settings := map[string]any{}
	patchStopHooks(settings)

	stop := stopEntries(t, settings)
	if len(stop) != 1 {
		t.Fatalf("want 1 Stop block, got %d", len(stop))
	}
	cmd := firstCommand(t, stop[0])
	if !strings.Contains(cmd, auraHookMarker) {
		t.Errorf("command missing marker: %q", cmd)
	}
}

func TestPatchStopHooks_PreservesUserHooks(t *testing.T) {
	settings := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{"type": "command", "command": "echo user-stop"},
					},
				},
			},
			"UserPromptSubmit": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{"type": "command", "command": "echo prompt"},
					},
				},
			},
		},
		"model": "claude-opus-4-7",
	}

	patchStopHooks(settings)

	if settings["model"] != "claude-opus-4-7" {
		t.Errorf("model dropped")
	}
	if _, ok := settings["hooks"].(map[string]any)["UserPromptSubmit"]; !ok {
		t.Errorf("UserPromptSubmit dropped")
	}

	stop := stopEntries(t, settings)
	if len(stop) != 2 {
		t.Fatalf("want 2 Stop blocks (user + aura), got %d", len(stop))
	}
	if !strings.Contains(firstCommand(t, stop[0]), "echo user-stop") {
		t.Errorf("user Stop hook overwritten")
	}
	if !strings.Contains(firstCommand(t, stop[1]), auraHookMarker) {
		t.Errorf("aura Stop hook missing")
	}
}

func TestPatchStopHooks_Idempotent(t *testing.T) {
	settings := map[string]any{}
	patchStopHooks(settings)
	patchStopHooks(settings)
	patchStopHooks(settings)

	stop := stopEntries(t, settings)
	count := 0
	for _, block := range stop {
		for _, entry := range innerHooks(t, block) {
			if strings.Contains(commandOf(t, entry), auraHookMarker) {
				count++
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly one aura-hook entry after repeated runs, got %d", count)
	}
}

func TestPatchStopHooks_ReplacesStaleAuraEntry(t *testing.T) {
	settings := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": "old-curl-command # aura-hook",
						},
					},
				},
			},
		},
	}

	patchStopHooks(settings)

	stop := stopEntries(t, settings)
	for _, block := range stop {
		for _, entry := range innerHooks(t, block) {
			cmd := commandOf(t, entry)
			if strings.Contains(cmd, "old-curl-command") {
				t.Errorf("stale aura-hook entry not replaced: %q", cmd)
			}
		}
	}
}

func TestRunSetupHooks_WritesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	existing := `{"model":"claude-opus-4-7"}`
	if err := os.WriteFile(path, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := runSetupHooks([]string{"-file", path}); err != nil {
		t.Fatalf("runSetupHooks: %v", err)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if got["model"] != "claude-opus-4-7" {
		t.Errorf("existing keys not preserved")
	}
	stop := stopEntries(t, got)
	if len(stop) != 1 {
		t.Fatalf("want 1 stop block, got %d", len(stop))
	}
}

func stopEntries(t *testing.T, settings map[string]any) []any {
	t.Helper()
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("settings.hooks missing")
	}
	stop, ok := hooks["Stop"].([]any)
	if !ok {
		t.Fatal("settings.hooks.Stop missing")
	}
	return stop
}

func innerHooks(t *testing.T, block any) []any {
	t.Helper()
	m, ok := block.(map[string]any)
	if !ok {
		t.Fatalf("block not a map: %T", block)
	}
	inner, _ := m["hooks"].([]any)
	return inner
}

func firstCommand(t *testing.T, block any) string {
	t.Helper()
	inner := innerHooks(t, block)
	if len(inner) == 0 {
		t.Fatal("empty inner hooks")
	}
	return commandOf(t, inner[0])
}

func commandOf(t *testing.T, entry any) string {
	t.Helper()
	m, ok := entry.(map[string]any)
	if !ok {
		t.Fatalf("entry not a map: %T", entry)
	}
	cmd, _ := m["command"].(string)
	return cmd
}
