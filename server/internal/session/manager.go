// Package session owns the lifecycle of tmux-backed PTY sessions.
//
// A Session is a long-lived tmux session plus the currently-attached PTY
// (if any). Clients come and go; sessions stay alive until they are
// explicitly killed or the tmux server exits.
package session

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/Shinyaigeek/aura/server/internal/tmux"
	"github.com/creack/pty"
)

// Manager owns the set of live Sessions.
type Manager struct {
	defaultShell string
	// extraEnv is applied to every spawned shell. Mirrored into the tmux
	// invocation's process env so the tmux server (created by the first
	// `new-session -A`) inherits these vars and hands them to every shell it
	// later spawns. Used to expose AURA_SESSION_ID / AURA_URL / AURA_TOKEN so
	// hook scripts running under Claude Code can call back into this server
	// without needing any side-channel config.
	extraEnv func(id string) []string

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager(shell string) *Manager {
	return &Manager{
		defaultShell: shell,
		sessions:     make(map[string]*Session),
	}
}

// SetExtraEnv installs a function that returns KEY=VALUE strings to inject
// into every spawned tmux session. Called once at startup; the Manager will
// invoke it per-session so the function can include the session id.
func (m *Manager) SetExtraEnv(fn func(id string) []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.extraEnv = fn
}

// Attach returns a Session for the given logical id, creating or reattaching
// to the underlying tmux session as needed.
//
// Concurrent callers with the same id share the same Session. That is a
// deliberate choice: multiple attached clients see the same buffer, which
// matches tmux's own semantics.
func (m *Manager) Attach(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[id]; ok && s.Alive() {
		return s, nil
	}

	var env []string
	if m.extraEnv != nil {
		env = m.extraEnv(id)
	}
	s, err := startSession(id, m.defaultShell, env)
	if err != nil {
		return nil, err
	}
	m.sessions[id] = s

	go func() {
		s.wait()
		m.mu.Lock()
		if current, ok := m.sessions[id]; ok && current == s {
			delete(m.sessions, id)
		}
		m.mu.Unlock()
	}()

	return s, nil
}

// CloseAll tears down every live session. Called on shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		_ = s.Close()
		delete(m.sessions, id)
	}
}

// Kill tears down the attached client and terminates the underlying tmux
// session. Unlike Close, this is destructive — the tmux session is gone and
// reattaching with the same id produces a fresh shell.
func (m *Manager) Kill(id string) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()

	if s != nil {
		_ = s.Close()
	}

	out, err := exec.Command("tmux", tmux.KillArgs(id)...).CombinedOutput()
	if err != nil {
		msg := string(out)
		// Idempotent: if the session doesn't exist on the tmux side we're done.
		if strings.Contains(msg, "can't find session") || strings.Contains(msg, "no server running") {
			return nil
		}
		return fmt.Errorf("tmux kill-session %q: %w: %s", id, err, msg)
	}
	return nil
}

// Session is a single tmux session plus its attached PTY.
type Session struct {
	ID string

	cmd *exec.Cmd
	pty *os.File

	mu     sync.Mutex
	closed bool
	done   chan struct{}
}

func startSession(id, shell string, extraEnv []string) (*Session, error) {
	// Anchor freshly created tmux sessions at $HOME so they don't inherit
	// aura-server's launch cwd (which sometimes happens to be inside an
	// unrelated repo). Reattaches to existing sessions ignore -c and keep
	// their pane's cwd, which is what we want.
	startDir, _ := os.UserHomeDir()
	args := tmux.EnsureArgs(id, shell, startDir)
	cmd := exec.Command("tmux", args...)
	// Inherit env but force a reasonable TERM so tmux renders correctly.
	// extraEnv is appended so the tmux server (spawned by this `new-session
	// -A` if no server is running yet) inherits AURA_* and propagates them to
	// every shell. We used to also pass `tmux -e KEY=VAL` for per-session env,
	// but that flag requires tmux >= 3.2 which Ubuntu 20.04 doesn't ship.
	baseEnv := append(os.Environ(), "TERM=xterm-256color")
	baseEnv = append(baseEnv, extraEnv...)
	cmd.Env = baseEnv

	f, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("start tmux session %q: %w", id, err)
	}

	return &Session{
		ID:   id,
		cmd:  cmd,
		pty:  f,
		done: make(chan struct{}),
	}, nil
}

// Read implements io.Reader over the PTY master.
func (s *Session) Read(p []byte) (int, error)  { return s.pty.Read(p) }
func (s *Session) Write(p []byte) (int, error) { return s.pty.Write(p) }

// Resize notifies the PTY of a new terminal size.
func (s *Session) Resize(rows, cols uint16) error {
	return pty.Setsize(s.pty, &pty.Winsize{Rows: rows, Cols: cols})
}

// Alive reports whether the underlying tmux process is still running.
func (s *Session) Alive() bool {
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// Close detaches and kills the tmux client process (not the tmux session
// itself — that lives on in the tmux server and can be reattached later).
//
// Specifically: we close our PTY, which sends SIGHUP to the `tmux new-session
// -A` client that spawned it. The tmux *server* keeps the session running in
// the background, which is the whole point.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()

	err := s.pty.Close()
	_ = s.cmd.Process.Kill()
	return err
}

func (s *Session) wait() {
	err := s.cmd.Wait()
	if err != nil {
		slog.Info("tmux client exited", "id", s.ID, "err", err)
	}
	close(s.done)
}

// Ensure *Session satisfies io.ReadWriteCloser.
var _ io.ReadWriteCloser = (*Session)(nil)
