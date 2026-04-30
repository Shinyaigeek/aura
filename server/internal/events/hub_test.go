package events

import (
	"sync"
	"testing"
	"time"
)

func TestHubBroadcastReachesSubscriber(t *testing.T) {
	h := New()
	ch, unsub := h.Subscribe()
	defer unsub()

	want := Event{Type: "stop", SessionID: "1", Body: "done"}
	h.Broadcast(want)

	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("got %+v want %+v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber never received broadcast")
	}
}

func TestHubFanOutToAllSubscribers(t *testing.T) {
	h := New()
	const n = 5
	chs := make([]<-chan Event, n)
	unsubs := make([]func(), n)
	for i := range chs {
		chs[i], unsubs[i] = h.Subscribe()
	}
	defer func() {
		for _, u := range unsubs {
			u()
		}
	}()

	if got := h.SubscriberCount(); got != n {
		t.Fatalf("SubscriberCount=%d want %d", got, n)
	}

	h.Broadcast(Event{Type: "stop", SessionID: "x"})
	for i, ch := range chs {
		select {
		case got := <-ch:
			if got.SessionID != "x" {
				t.Fatalf("subscriber %d got %+v", i, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("subscriber %d missed broadcast", i)
		}
	}
}

func TestHubUnsubscribeStopsDelivery(t *testing.T) {
	h := New()
	ch, unsub := h.Subscribe()
	unsub()

	// Channel is closed; subsequent broadcasts must not panic.
	h.Broadcast(Event{Type: "stop"})

	// Reading from a closed channel returns zero-value immediately.
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("received event after unsubscribe")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("read from closed channel blocked")
	}

	if got := h.SubscriberCount(); got != 0 {
		t.Fatalf("SubscriberCount=%d want 0", got)
	}
}

func TestHubUnsubscribeIdempotent(t *testing.T) {
	h := New()
	_, unsub := h.Subscribe()
	unsub()
	unsub() // must not panic or double-close
}

func TestHubBroadcastDropsWhenSubscriberSlow(t *testing.T) {
	h := New()
	_, unsub := h.Subscribe()
	defer unsub()

	// Fill the buffer + one extra so we deterministically see a drop.
	for range subscriberBuffer + 4 {
		h.Broadcast(Event{Type: "stop"})
	}
	// Test passes if Broadcast didn't block. The dropped events are not
	// observable from outside the hub.
}

func TestHubBroadcastIsConcurrencySafe(t *testing.T) {
	h := New()
	const producers = 10
	const events = 50

	var wg sync.WaitGroup
	wg.Add(producers)
	for range producers {
		go func() {
			defer wg.Done()
			for range events {
				h.Broadcast(Event{Type: "stop"})
			}
		}()
	}

	// Concurrent subscribe/unsubscribe to stress the mutex.
	for range 5 {
		ch, unsub := h.Subscribe()
		go func() {
			for range ch {
			}
		}()
		defer unsub()
	}

	wg.Wait()
}
