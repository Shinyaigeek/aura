// Package tmux wraps the tmux CLI so aura-server can treat a named tmux
// session as a durable, client-independent PTY.
package tmux

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

const sessionPrefix = "aura-"

// SessionName maps a logical session id to the tmux session name used on disk.
func SessionName(id string) string {
	return sessionPrefix + id
}

// Exists reports whether a tmux session with the given logical id is alive.
func Exists(id string) (bool, error) {
	cmd := exec.Command("tmux", "has-session", "-t", SessionName(id))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	if _, ok := err.(*exec.ExitError); ok {
		// has-session exits non-zero when the session is missing; that is not
		// an error from our perspective.
		if strings.Contains(stderr.String(), "can't find session") ||
			strings.Contains(stderr.String(), "no server running") {
			return false, nil
		}
		return false, nil
	}
	return false, fmt.Errorf("tmux has-session: %w: %s", err, stderr.String())
}

// EnsureArgs returns the argv used to attach to a session, creating it with
// `shell` if it does not yet exist.
//
// We rely on `tmux new-session -A` which means "attach if exists, else
// create." This is the single operation that makes the reattach path safe
// against races: two clients connecting simultaneously both land in the same
// session.
//
// `startDir`, when non-empty, is passed as `-c` so a freshly created session
// starts there instead of inheriting aura-server's cwd (which is whatever the
// server happened to be launched from). Tmux ignores `-c` on the attach branch
// of `-A`, so live sessions keep their current pane cwd.
//
// Per-session env injection used to live here as `-e KEY=VAL`, but `new-session
// -e` requires tmux >= 3.2 which Ubuntu 20.04 (3.0a) doesn't ship. Callers now
// propagate AURA_* via the parent process env (cmd.Env in session.startSession);
// the first `new-session -A` spawns the tmux server, which inherits that env
// and hands it to every shell it later creates.
func EnsureArgs(id, shell, startDir string) []string {
	args := []string{"new-session", "-A"}
	if startDir != "" {
		args = append(args, "-c", startDir)
	}
	args = append(args, "-s", SessionName(id), shell)
	return args
}

// KillArgs returns argv to terminate a session explicitly. Normally we never
// call this — the whole point of aura is that sessions outlive clients — but
// it is useful for tests and admin tooling.
func KillArgs(id string) []string {
	return []string{"kill-session", "-t", SessionName(id)}
}

// SendKeys types text into the (single) pane of the given logical session and
// submits it with Enter, exactly as if a human had typed at the keyboard. It
// works whether or not a client is attached — the keystrokes go to the pane
// owned by the tmux server — which makes it the durable way to drive a session
// from outside the WebSocket path (e.g. an Alexa skill POSTing a prompt).
//
// text is sent with `-l` (literal) so its bytes are never interpreted as tmux
// key names; the trailing Enter is a separate, non-literal send so it submits
// the line. Embedded newlines are stripped first: a voice/HTTP-injected prompt
// is a single line, and a stray newline would submit it half-typed.
func SendKeys(id, text string) error {
	name := SessionName(id)
	text = strings.ReplaceAll(text, "\r", "")
	text = strings.ReplaceAll(text, "\n", " ")

	if out, err := exec.Command("tmux", "send-keys", "-t", name, "-l", "--", text).CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys (text): %w: %s", err, out)
	}
	if out, err := exec.Command("tmux", "send-keys", "-t", name, "Enter").CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys (enter): %w: %s", err, out)
	}
	return nil
}

// PaneCurrentPath asks tmux for the working directory of the (single) pane in
// the given logical session. Used by the mobile directory browser so the user
// can start navigation from where the shell currently is rather than $HOME.
func PaneCurrentPath(id string) (string, error) {
	cmd := exec.Command("tmux", "display-message", "-p", "-t", SessionName(id), "#{pane_current_path}")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("tmux display-message: %w: %s", err, stderr.String())
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}
