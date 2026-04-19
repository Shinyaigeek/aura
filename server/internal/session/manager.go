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
	"sync"

	"github.com/Shinyaigeek/aura/server/internal/tmux"
	"github.com/creack/pty"
)

// Manager owns the set of live Sessions.
type Manager struct {
	defaultShell string

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager(shell string) *Manager {
	return &Manager{
		defaultShell: shell,
		sessions:     make(map[string]*Session),
	}
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

	s, err := startSession(id, m.defaultShell)
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

// Session is a single tmux session plus its attached PTY.
type Session struct {
	ID string

	cmd *exec.Cmd
	pty *os.File

	mu     sync.Mutex
	closed bool
	done   chan struct{}
}

func startSession(id, shell string) (*Session, error) {
	args := tmux.EnsureArgs(id, shell)
	cmd := exec.Command("tmux", args...)
	// Inherit env but force a reasonable TERM so tmux renders correctly.
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

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
