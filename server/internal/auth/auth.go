package auth

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// Token returns middleware that rejects requests without the configured shared
// token. The token may be supplied as a Bearer header or a `token` query
// parameter. If the configured token is empty, all requests are rejected.
func Token(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if expected == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			got := extract(r)
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func extract(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimPrefix(h, "Bearer ")
		}
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	// Sec-WebSocket-Protocol is the usual way browsers pass auth on WS upgrades.
	if p := r.Header.Get("Sec-WebSocket-Protocol"); p != "" {
		for _, part := range strings.Split(p, ",") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "bearer.") {
				return strings.TrimPrefix(part, "bearer.")
			}
		}
	}
	return ""
}
