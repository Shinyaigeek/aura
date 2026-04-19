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
func EnsureArgs(id, shell string) []string {
	return []string{
		"new-session",
		"-A",
		"-s", SessionName(id),
		shell,
	}
}

// KillArgs returns argv to terminate a session explicitly. Normally we never
// call this — the whole point of aura is that sessions outlive clients — but
// it is useful for tests and admin tooling.
func KillArgs(id string) []string {
	return []string{"kill-session", "-t", SessionName(id)}
}
