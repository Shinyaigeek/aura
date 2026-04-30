// Package events fans Claude Code hook events out to every connected
// /events WebSocket subscriber.
//
// Producers (the /hooks/* HTTP handlers) call Broadcast; consumers (the
// /events WS handler) call Subscribe to obtain a channel + an unsubscribe
// closure.
//
// Backpressure: each subscriber has a small buffered channel. If a slow
// consumer's buffer is full when an event is broadcast, that one event is
// dropped for that subscriber rather than blocking the producer or the
// other subscribers — a missed Stop notification is preferable to a stuck
// hook handler.
package events

import (
	"sync"
)

// Event is the wire shape sent to /events subscribers. Marshaled as JSON
// by the WS handler. Type discriminates the rest:
//
//   - "stop":         Claude Code Stop hook fired (a session finished).
//   - "notification": Claude Code Notification hook fired (idle/permission
//     prompt). Body carries the prompt text from CC's payload.
type Event struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
	Title     string `json:"title,omitempty"`
	Body      string `json:"body,omitempty"`
}

// Hub is a fan-out broadcaster. The zero value is unusable; call New.
type Hub struct {
	mu          sync.Mutex
	subscribers map[*subscriber]struct{}
}

type subscriber struct {
	ch chan Event
}

// subscriberBuffer is the per-client queue depth. 16 is enough to absorb
// a small burst (e.g. a Notification + a Stop arriving back-to-back) but
// small enough that a stuck consumer can't grow memory unbounded.
const subscriberBuffer = 16

func New() *Hub {
	return &Hub{subscribers: map[*subscriber]struct{}{}}
}

// Subscribe registers a new consumer. The returned channel receives every
// future Broadcast (events broadcast before Subscribe are not replayed).
// The returned closure removes the subscriber and closes its channel; it
// is safe to call multiple times.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, subscriberBuffer)}
	h.mu.Lock()
	h.subscribers[s] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	unsub := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, s)
			h.mu.Unlock()
			close(s.ch)
		})
	}
	return s.ch, unsub
}

// Broadcast sends ev to every current subscriber. Subscribers whose queue
// is full miss this event but stay subscribed; intent is "lossy but
// non-blocking" so a wedged client never stalls a hook handler.
func (h *Hub) Broadcast(ev Event) {
	h.mu.Lock()
	subs := make([]*subscriber, 0, len(h.subscribers))
	for s := range h.subscribers {
		subs = append(subs, s)
	}
	h.mu.Unlock()

	for _, s := range subs {
		select {
		case s.ch <- ev:
		default:
		}
	}
}

// SubscriberCount is for tests and observability — never use it for routing
// decisions, the value is racy by definition.
func (h *Hub) SubscriberCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}
