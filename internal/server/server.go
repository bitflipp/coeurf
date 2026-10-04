// Package server exposes the static editor and, when a store is configured,
// the JSON API for saving designs.
package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"time"

	"coeurf/internal/store"
)

// maxBodyBytes bounds the size of a saved design.
const maxBodyBytes = 16 << 20

type server struct {
	store *store.Store
}

// New returns the HTTP handler serving the files in static. With a nil store
// the API is absent and /api/config reports storage as disabled, so the
// editor runs purely in the browser.
func New(static fs.FS, st *store.Store) http.Handler {
	s := &server{store: st}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.config)
	if st != nil {
		mux.HandleFunc("GET /api/designs", s.list)
		mux.HandleFunc("POST /api/designs", s.create)
		mux.HandleFunc("GET /api/designs/{id}", s.get)
		mux.HandleFunc("PUT /api/designs/{id}", s.save)
		mux.HandleFunc("PATCH /api/designs/{id}", s.rename)
		mux.HandleFunc("DELETE /api/designs/{id}", s.delete)
		mux.HandleFunc("GET /api/designs/{id}/versions", s.versions)
		mux.HandleFunc("GET /api/designs/{id}/versions/{version}", s.version)
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	mux.Handle("/", http.FileServerFS(static))
	return noCache(mux)
}

// noCache makes browsers revalidate: the embedded files have no modification
// time, so a stale app.js could otherwise outlive a new binary.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func (s *server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"storage": s.store != nil})
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	designs, err := s.store.List(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, designs)
}

type saveRequest struct {
	Name        string          `json:"name"`
	Data        json.RawMessage `json:"data"`
	BaseVersion int             `json:"base_version"`
}

// designResponse is a design with the data of one of its versions: Version
// is that version, Latest the design's newest one.
type designResponse struct {
	ID      int64           `json:"id"`
	Name    string          `json:"name"`
	Version int             `json:"version"`
	Latest  int             `json:"latest"`
	SavedAt time.Time       `json:"saved_at"`
	Data    json.RawMessage `json:"data"`
}

func respond(w http.ResponseWriter, status int, d store.Design, v store.Version) {
	writeJSON(w, status, designResponse{
		ID: d.ID, Name: d.Name, Version: v.Version, Latest: d.Version, SavedAt: v.CreatedAt, Data: v.Data,
	})
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if !decode(w, r, &req) {
		return
	}
	d, v, err := s.store.Create(r.Context(), req.Name, req.Data)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, http.StatusCreated, d, v)
}

func (s *server) get(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	d, v, err := s.store.Get(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, http.StatusOK, d, v)
}

func (s *server) save(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	var req saveRequest
	if !decode(w, r, &req) {
		return
	}
	d, v, err := s.store.Save(r.Context(), id, req.BaseVersion, req.Data)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, http.StatusOK, d, v)
}

func (s *server) rename(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	var req saveRequest
	if !decode(w, r, &req) {
		return
	}
	if err := s.store.Rename(r.Context(), id, req.Name); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.Delete(r.Context(), id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) versions(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	vs, err := s.store.Versions(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (s *server) version(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	n, ok := pathInt(w, r, "version")
	if !ok {
		return
	}
	d, _, err := s.store.Get(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	v, err := s.store.GetVersion(r.Context(), id, int(n))
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, http.StatusOK, d, v)
}

func pathInt(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || n <= 0 {
		writeError(w, http.StatusBadRequest, "invalid "+name)
		return 0, false
	}
	return n, true
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "design too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	return true
}

func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "design was changed since it was loaded")
	case errors.Is(err, store.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		log.Printf("internal error: %v", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}
