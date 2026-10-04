// Command coeurf serves the cœurf editor as a single binary with its static
// files embedded. If COEURF_DB_DSN is set, designs can also be saved, with
// version history, in a MySQL-compatible database.
package main

import (
	"context"
	"embed"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"coeurf/internal/server"
	"coeurf/internal/store"
)

//go:embed index.html app.js style.css icon.svg apple-touch-icon.png
var static embed.FS

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := os.Getenv("COEURF_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	var st *store.Store
	if dsn := os.Getenv("COEURF_DB_DSN"); dsn != "" {
		var err error
		if st, err = store.Open(ctx, dsn); err != nil {
			return err
		}
		defer st.Close()
		log.Print("storage enabled")
	} else {
		log.Print("COEURF_DB_DSN not set: storage disabled")
	}

	srv := &http.Server{Addr: addr, Handler: server.New(static, st), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("listening on %s", addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
