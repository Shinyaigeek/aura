package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// auraStopCommand is the shell one-liner installed as Claude Code's Stop
// hook. Claude Code pipes its native hook-event JSON (including
// transcript_path) into the hook process's stdin, so we forward that
// straight through to aura-server via `--data-binary @-` and identify the
// originating tmux pane with an `X-Aura-Session-Id` header. Every guard is
// intentional:
//
//   - The `[ -n "$AURA_URL" ] && [ -n "$AURA_SESSION_ID" ]` pair makes the
//     hook a no-op when Claude Code runs outside an aura-provisioned tmux
//     pane (e.g. the user runs Claude manually on their laptop).
//   - Wrapping the chain in `(...) >/dev/null 2>&1 || true` swallows every
//     failure mode — network timeout, server down, missing curl — so a CC
//     session never blocks on a broken notification path.
//   - `# aura-hook-stop` / `# aura-hook-notification` are the idempotency
//     markers setup-hooks looks for on re-runs so it can replace the
//     entry in place instead of appending a duplicate. Both contain the
//     `aura-hook` substring so a legacy entry tagged `# aura-hook` (the
//     pre-Notification-support marker) is also picked up and replaced.
const auraStopCommand = `([ -n "$AURA_URL" ] && [ -n "$AURA_SESSION_ID" ] && curl -sS -m 5 -X POST -H "Authorization: Bearer $AURA_TOKEN" -H "Content-Type: application/json" -H "X-Aura-Session-Id: $AURA_SESSION_ID" --data-binary @- "$AURA_URL/hooks/stop") >/dev/null 2>&1 || true # aura-hook-stop`

const auraNotificationCommand = `([ -n "$AURA_URL" ] && [ -n "$AURA_SESSION_ID" ] && curl -sS -m 5 -X POST -H "Authorization: Bearer $AURA_TOKEN" -H "Content-Type: application/json" -H "X-Aura-Session-Id: $AURA_SESSION_ID" --data-binary @- "$AURA_URL/hooks/notification") >/dev/null 2>&1 || true # aura-hook-notification`

// auraHookMarker matches every aura-installed hook entry, regardless of
// event type. Used by patchEventHooks to strip stale entries before
// installing a fresh one.
const auraHookMarker = "aura-hook"

// runSetupHooks patches ~/.claude/settings.json so Claude Code fires the
// aura hook commands on Stop and Notification events. Idempotent:
// re-running replaces existing aura-hook entries rather than appending
// duplicates. All other settings keys are preserved verbatim.
func runSetupHooks(args []string) error {
	fs := flag.NewFlagSet("setup-hooks", flag.ContinueOnError)
	path := fs.String("file", defaultSettingsPath(), "path to Claude Code settings.json")
	dryRun := fs.Bool("dry-run", false, "print the resulting settings.json to stdout instead of writing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("cannot resolve default settings path; pass -file")
	}

	settings, err := loadSettings(*path)
	if err != nil {
		return err
	}

	patchHooks(settings)

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}

	if *dryRun {
		fmt.Println(string(out))
		return nil
	}

	if err := writeSettings(*path, out); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "installed aura Stop + Notification hooks in %s\n", *path)
	return nil
}

func loadSettings(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(b) == 0 {
		return map[string]any{}, nil
	}
	settings := map[string]any{}
	if err := json.Unmarshal(b, &settings); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return settings, nil
}

// patchHooks mutates settings so its `.hooks.Stop` and `.hooks.Notification`
// arrays each end with exactly one aura-hook entry, leaving any
// user-defined hooks alone.
func patchHooks(settings map[string]any) {
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		hooks = map[string]any{}
	}
	hooks["Stop"] = patchEventHooks(hooks["Stop"], auraStopCommand)
	hooks["Notification"] = patchEventHooks(hooks["Notification"], auraNotificationCommand)
	settings["hooks"] = hooks
}

// patchEventHooks strips any pre-existing aura-hook entries from a single
// event's hook array and appends a fresh one carrying newCommand. We match
// on the marker substring rather than the whole command so upgrades (which
// may change curl flags or guards) replace old installs cleanly.
func patchEventHooks(existing any, newCommand string) []any {
	blocks, _ := existing.([]any)
	cleaned := make([]any, 0, len(blocks)+1)
	for _, rawBlock := range blocks {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			cleaned = append(cleaned, rawBlock)
			continue
		}
		inner, _ := block["hooks"].([]any)
		prunedInner := make([]any, 0, len(inner))
		for _, rawEntry := range inner {
			entry, ok := rawEntry.(map[string]any)
			if !ok {
				prunedInner = append(prunedInner, rawEntry)
				continue
			}
			cmd, _ := entry["command"].(string)
			if strings.Contains(cmd, auraHookMarker) {
				continue
			}
			prunedInner = append(prunedInner, rawEntry)
		}
		if len(prunedInner) == 0 {
			// Drop the whole block if we emptied it — leaving an empty
			// hooks array in place would be harmless but noisy.
			continue
		}
		block["hooks"] = prunedInner
		cleaned = append(cleaned, block)
	}

	cleaned = append(cleaned, map[string]any{
		"hooks": []any{
			map[string]any{
				"type":    "command",
				"command": newCommand,
			},
		},
	})
	return cleaned
}

func writeSettings(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp settings: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp settings: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp settings: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("chmod temp settings: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename temp settings: %w", err)
	}
	return nil
}

func defaultSettingsPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "settings.json")
}
