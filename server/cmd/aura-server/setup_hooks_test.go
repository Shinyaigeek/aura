package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPatchHooks_EmptySettings(t *testing.T) {
	settings := map[string]any{}
	patchHooks(settings)

	stop := eventEntries(t, settings, "Stop")
	if len(stop) != 1 {
		t.Fatalf("want 1 Stop block, got %d", len(stop))
	}
	if !strings.Contains(firstCommand(t, stop[0]), "aura-hook-stop") {
		t.Errorf("Stop command missing aura-hook-stop marker")
	}

	notif := eventEntries(t, settings, "Notification")
	if len(notif) != 1 {
		t.Fatalf("want 1 Notification block, got %d", len(notif))
	}
	if !strings.Contains(firstCommand(t, notif[0]), "aura-hook-notification") {
		t.Errorf("Notification command missing aura-hook-notification marker")
	}
}

func TestPatchHooks_PreservesUserHooks(t *testing.T) {
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

	patchHooks(settings)

	if settings["model"] != "claude-opus-4-7" {
		t.Errorf("model dropped")
	}
	if _, ok := settings["hooks"].(map[string]any)["UserPromptSubmit"]; !ok {
		t.Errorf("UserPromptSubmit dropped")
	}

	stop := eventEntries(t, settings, "Stop")
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

func TestPatchHooks_Idempotent(t *testing.T) {
	settings := map[string]any{}
	patchHooks(settings)
	patchHooks(settings)
	patchHooks(settings)

	for _, ev := range []string{"Stop", "Notification"} {
		count := 0
		for _, block := range eventEntries(t, settings, ev) {
			for _, entry := range innerHooks(t, block) {
				if strings.Contains(commandOf(t, entry), auraHookMarker) {
					count++
				}
			}
		}
		if count != 1 {
			t.Errorf("%s: want 1 aura-hook entry after repeated runs, got %d", ev, count)
		}
	}
}

func TestPatchHooks_ReplacesLegacyAuraEntry(t *testing.T) {
	// Legacy installs (pre-Notification support) used the bare `# aura-hook`
	// marker on the Stop array. The new patcher must recognise these and
	// replace them, not leave them next to the new entry.
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

	patchHooks(settings)

	for _, block := range eventEntries(t, settings, "Stop") {
		for _, entry := range innerHooks(t, block) {
			if strings.Contains(commandOf(t, entry), "old-curl-command") {
				t.Errorf("legacy aura-hook entry not replaced: %q", commandOf(t, entry))
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
	if len(eventEntries(t, got, "Stop")) != 1 {
		t.Errorf("want 1 Stop block")
	}
	if len(eventEntries(t, got, "Notification")) != 1 {
		t.Errorf("want 1 Notification block")
	}
}

func eventEntries(t *testing.T, settings map[string]any, event string) []any {
	t.Helper()
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("settings.hooks missing")
	}
	entries, ok := hooks[event].([]any)
	if !ok {
		t.Fatalf("settings.hooks.%s missing", event)
	}
	return entries
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
