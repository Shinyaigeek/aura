// Package difit owns the lifecycle of difit (https://github.com/yoshiko-pg/difit)
// processes spawned alongside aura sessions.
//
// One difit instance per session, started lazily via Start, anchored at the
// session's pane cwd, listening on 0.0.0.0:<freeport>. The mobile app loads it
// in a WebView. We bind on all interfaces because aura is reached over a VPN /
// SSH tunnel — there is no LAN-exposure risk in the deployment model and difit
// has no auth of its own.
package difit

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Manager owns the set of live difit processes, keyed by session id.
type Manager struct {
	cmdName string

	mu        sync.Mutex
	processes map[string]*Process
}

// Process is a running difit instance.
type Process struct {
	ID   string
	Port int

	cmd  *exec.Cmd
	done chan struct{}
}

// NewManager returns a Manager that spawns difit via the given command name
// (typically "difit" on PATH).
func NewManager(cmdName string) *Manager {
	if cmdName == "" {
		cmdName = "difit"
	}
	return &Manager{
		cmdName:   cmdName,
		processes: make(map[string]*Process),
	}
}

// Start spawns difit for the given session in cwd, or returns the live
// instance if one already exists. The returned port is what the client should
// connect to.
//
// difit is started with the "working" commit-ish so the diff shown is the
// uncommitted changes against HEAD — matching the mental model of `git diff`.
func (m *Manager) Start(id, cwd string) (*Process, error) {
	m.mu.Lock()
	if existing, ok := m.processes[id]; ok && existing.alive() {
		m.mu.Unlock()
		return existing, nil
	}
	// Drop any dead entry left over from a previous run before we replace it.
	delete(m.processes, id)
	m.mu.Unlock()

	port, err := freePort()
	if err != nil {
		return nil, fmt.Errorf("pick free port: %w", err)
	}

	cmd := exec.Command(
		m.cmdName,
		"working",
		"--port", strconv.Itoa(port),
		"--host", "0.0.0.0",
		"--no-open",
		"--keep-alive",
	)
	cmd.Dir = cwd
	// difit prompts on stdin when there are untracked files. Saying "yes"
	// triggers `git add --intent-to-add` on those paths — a real, surprising
	// side-effect that mutates the user's index. We answer "n" so the diff
	// shows tracked-but-unstaged changes only (matching the user's request)
	// and the working tree is left untouched. With no tty, difit otherwise
	// reads EOF on the prompt and exits before binding, so leaving stdin
	// unset is not an option either.
	cmd.Stdin = strings.NewReader("n\n")

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("difit stderr pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("difit stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start difit: %w", err)
	}

	p := &Process{
		ID:   id,
		Port: port,
		cmd:  cmd,
		done: make(chan struct{}),
	}

	go drain("difit stdout", id, stdout)
	go drain("difit stderr", id, stderr)

	go func() {
		err := cmd.Wait()
		if err != nil && !errors.Is(err, exec.ErrNotFound) {
			slog.Info("difit exited", "session", id, "port", port, "err", err)
		}
		close(p.done)
		m.mu.Lock()
		if current, ok := m.processes[id]; ok && current == p {
			delete(m.processes, id)
		}
		m.mu.Unlock()
	}()

	if err := waitReady(port, 5*time.Second, p.done); err != nil {
		_ = p.kill()
		return nil, err
	}

	m.mu.Lock()
	// Re-check for a concurrent Start that won the race. If somebody else got
	// in first, drop ours and return theirs — sticking to one process per id
	// is the whole invariant of this package.
	if existing, ok := m.processes[id]; ok && existing.alive() {
		m.mu.Unlock()
		_ = p.kill()
		return existing, nil
	}
	m.processes[id] = p
	m.mu.Unlock()

	slog.Info("difit started", "session", id, "port", port, "cwd", cwd)
	return p, nil
}

// Stop terminates the difit process for the given session, if any.
func (m *Manager) Stop(id string) {
	m.mu.Lock()
	p, ok := m.processes[id]
	if ok {
		delete(m.processes, id)
	}
	m.mu.Unlock()
	if p != nil {
		_ = p.kill()
	}
}

// StopAll terminates every live difit process. Called on shutdown.
func (m *Manager) StopAll() {
	m.mu.Lock()
	procs := make([]*Process, 0, len(m.processes))
	for id, p := range m.processes {
		procs = append(procs, p)
		delete(m.processes, id)
	}
	m.mu.Unlock()
	for _, p := range procs {
		_ = p.kill()
	}
}

func (p *Process) alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *Process) kill() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

// freePort asks the kernel for an unused TCP port. There's a tiny TOCTOU
// window between us closing the listener and difit binding, but the cost
// of a collision is just an HTTP 500 the user can retry — not worth a
// heavier scheme.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// waitReady polls difit's port until it accepts TCP connections or the
// process dies / we hit timeout.
func waitReady(port int, timeout time.Duration, done <-chan struct{}) error {
	deadline := time.Now().Add(timeout)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	for {
		select {
		case <-done:
			return errors.New("difit exited before becoming ready")
		default:
		}
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("difit not ready on :%d after %s", port, timeout)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// drain logs anything difit writes to stdout/stderr at debug level and
// keeps the pipe from filling up. We don't parse output — readiness is
// detected via TCP probe instead.
func drain(label, id string, r io.ReadCloser) {
	defer func() { _ = r.Close() }()
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			slog.Debug(label, "session", id, "out", string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}
