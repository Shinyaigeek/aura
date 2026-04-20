// Package devices persists the set of mobile devices registered to receive
// push notifications from aura-server. Backing store is a single JSON file
// under the user's config dir, rewritten atomically on each mutation.
package devices

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Device is one registered mobile client.
type Device struct {
	// ExpoPushToken is the identifier Expo issues for a specific install.
	// We treat it as the primary key: re-registering the same token is a
	// no-op aside from bumping UpdatedAt.
	ExpoPushToken string    `json:"expoPushToken"`
	Platform      string    `json:"platform,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// Store is a concurrency-safe JSON-file-backed device registry.
type Store struct {
	path string

	mu      sync.Mutex
	devices map[string]Device
}

// Open loads the store at path, creating an empty one if the file is absent.
func Open(path string) (*Store, error) {
	s := &Store{path: path, devices: make(map[string]Device)}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read devices store: %w", err)
	}
	if len(b) == 0 {
		return nil
	}
	var list []Device
	if err := json.Unmarshal(b, &list); err != nil {
		return fmt.Errorf("parse devices store: %w", err)
	}
	for _, d := range list {
		if d.ExpoPushToken == "" {
			continue
		}
		s.devices[d.ExpoPushToken] = d
	}
	return nil
}

// Register upserts a device. Re-registering an existing token just refreshes
// UpdatedAt, which doubles as a liveness signal.
func (s *Store) Register(token, platform string) error {
	if token == "" {
		return errors.New("empty expo push token")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	d, ok := s.devices[token]
	if !ok {
		d = Device{ExpoPushToken: token, CreatedAt: now}
	}
	if platform != "" {
		d.Platform = platform
	}
	d.UpdatedAt = now
	s.devices[token] = d
	return s.flushLocked()
}

// Remove drops a device by token. No-op if absent.
func (s *Store) Remove(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.devices[token]; !ok {
		return nil
	}
	delete(s.devices, token)
	return s.flushLocked()
}

// List returns a snapshot of registered devices ordered by UpdatedAt desc.
func (s *Store) List() []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Device, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out
}

func (s *Store) flushLocked() error {
	list := make([]Device, 0, len(s.devices))
	for _, d := range s.devices {
		list = append(list, d)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].ExpoPushToken < list[j].ExpoPushToken
	})
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal devices: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("mkdir devices store: %w", err)
	}
	// Write + rename so a crash mid-write can't corrupt the file.
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".devices-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp devices store: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp devices store: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp devices store: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("chmod temp devices store: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("rename devices store: %w", err)
	}
	return nil
}
