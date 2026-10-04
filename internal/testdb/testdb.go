// Package testdb opens the Store used by tests, against a real database.
package testdb

import (
	"context"
	"os"
	"testing"

	"coeurf/internal/store"
)

// Open connects to the database named by COEURF_DB_DSN, for example
// "coeurf:coeurf@/coeurf?parseTime=true". The tests skip when it is unset.
// Tests share the database, so each one must create its own designs, clean
// them up, and not assume the database is otherwise empty.
func Open(t testing.TB) *store.Store {
	t.Helper()
	dsn := os.Getenv("COEURF_DB_DSN")
	if dsn == "" {
		t.Skip("COEURF_DB_DSN not set")
	}
	s, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
