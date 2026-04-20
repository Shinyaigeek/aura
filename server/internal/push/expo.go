// Package push sends messages through the Expo Push API.
//
// Expo's API accepts batches of up to 100 push messages per HTTP request and
// returns a ticket per message. Tickets with status=error and a
// DeviceNotRegistered details code mean the token is dead and the caller
// should drop it from its store.
//
// Reference: https://docs.expo.dev/push-notifications/sending-notifications/
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	endpoint  = "https://exp.host/--/api/v2/push/send"
	batchSize = 100
)

// Message is a single push to a single token.
type Message struct {
	To    string         `json:"to"`
	Title string         `json:"title,omitempty"`
	Body  string         `json:"body,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
	Sound string         `json:"sound,omitempty"`
}

// Ticket is Expo's per-message response.
type Ticket struct {
	Status  string `json:"status"`
	ID      string `json:"id,omitempty"`
	Message string `json:"message,omitempty"`
	Details struct {
		Error string `json:"error,omitempty"`
	} `json:"details,omitempty"`
}

// IsDeviceNotRegistered reports whether this ticket means the token is dead
// and the caller should stop sending to it.
func (t Ticket) IsDeviceNotRegistered() bool {
	return t.Status == "error" && t.Details.Error == "DeviceNotRegistered"
}

// Client is a minimal Expo Push API client.
type Client struct {
	HTTP *http.Client
}

// NewClient returns a Client with sensible defaults.
func NewClient() *Client {
	return &Client{HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// Send delivers messages in batches of up to 100 and returns tickets in the
// same order as the input. On a batch-level HTTP failure, the corresponding
// input messages get a synthetic error ticket so callers can still reason
// per-message.
func (c *Client) Send(ctx context.Context, msgs []Message) ([]Ticket, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	tickets := make([]Ticket, 0, len(msgs))
	for i := 0; i < len(msgs); i += batchSize {
		end := i + batchSize
		if end > len(msgs) {
			end = len(msgs)
		}
		batch := msgs[i:end]
		ts, err := c.sendBatch(ctx, batch)
		if err != nil {
			// Degrade to per-message synthetic errors so the caller can keep
			// iterating instead of silently losing the batch.
			for range batch {
				tickets = append(tickets, Ticket{Status: "error", Message: err.Error()})
			}
			continue
		}
		tickets = append(tickets, ts...)
	}
	return tickets, nil
}

func (c *Client) sendBatch(ctx context.Context, batch []Message) ([]Ticket, error) {
	body, err := json.Marshal(batch)
	if err != nil {
		return nil, fmt.Errorf("marshal push batch: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build push request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "gzip, deflate")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("push request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("push returned %s", resp.Status)
	}

	var env struct {
		Data   []Ticket `json:"data"`
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, fmt.Errorf("decode push response: %w", err)
	}
	if len(env.Errors) > 0 {
		return nil, fmt.Errorf("push api error: %s", env.Errors[0].Message)
	}
	if len(env.Data) != len(batch) {
		return nil, fmt.Errorf("push ticket count mismatch: got %d want %d", len(env.Data), len(batch))
	}
	return env.Data, nil
}
