package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"coeurf/internal/store"
	"coeurf/internal/testdb"
)

var ctx = context.Background()

func open(t *testing.T) *store.Store {
	t.Helper()
	return testdb.Open(t)
}

func create(t *testing.T, s *store.Store, name string) store.Design {
	t.Helper()
	d, _, err := s.Create(ctx, name, json.RawMessage(`{"n":1}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Delete(ctx, d.ID) })
	return d
}

func TestCreateAndGet(t *testing.T) {
	s := open(t)
	d, v, err := s.Create(ctx, "  heart  ", json.RawMessage(`{"curves":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Delete(ctx, d.ID) })
	if d.Name != "heart" || d.Version != 1 || v.Version != 1 {
		t.Fatalf("unexpected design %+v version %+v", d, v)
	}
	got, gv, err := s.Get(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "heart" || got.Version != 1 || string(gv.Data) != `{"curves":[]}` {
		t.Fatalf("unexpected get: %+v %+v %s", got, gv, gv.Data)
	}
	if time.Since(got.CreatedAt) > time.Minute {
		t.Fatalf("created_at off: %v (parseTime/UTC problem?)", got.CreatedAt)
	}
}

func TestCreateValidation(t *testing.T) {
	s := open(t)
	long := make([]byte, 256)
	for i := range long {
		long[i] = 'x'
	}
	for name, c := range map[string]struct {
		name string
		data string
	}{
		"empty name":     {"", `{}`},
		"blank name":     {"   ", `{}`},
		"long name":      {string(long), `{}`},
		"array data":     {"a", `[]`},
		"null data":      {"a", `null`},
		"scalar data":    {"a", `1`},
		"malformed data": {"a", `{`},
		"empty data":     {"a", ``},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := s.Create(ctx, c.name, json.RawMessage(c.data)); !errors.Is(err, store.ErrInvalid) {
				t.Fatalf("got %v, want ErrInvalid", err)
			}
		})
	}
}

func TestSaveCreatesVersions(t *testing.T) {
	s := open(t)
	d := create(t, s, "versions")
	for i := 2; i <= 4; i++ {
		got, v, err := s.Save(ctx, d.ID, i-1, json.RawMessage(fmt.Sprintf(`{"n":%d}`, i)))
		if err != nil {
			t.Fatal(err)
		}
		if got.Version != i || v.Version != i {
			t.Fatalf("save %d returned version %d/%d", i, got.Version, v.Version)
		}
	}
	vs, err := s.Versions(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) != 4 || vs[0].Version != 4 || vs[3].Version != 1 {
		t.Fatalf("versions not newest-first: %+v", vs)
	}
	if vs[0].Data != nil {
		t.Fatal("version listing must not include data")
	}
	// Old versions stay readable and unchanged.
	v2, err := s.GetVersion(ctx, d.ID, 2)
	if err != nil || string(v2.Data) != `{"n":2}` {
		t.Fatalf("version 2: %v %s", err, v2.Data)
	}
	latest, lv, err := s.Get(ctx, d.ID)
	if err != nil || latest.Version != 4 || string(lv.Data) != `{"n":4}` {
		t.Fatalf("latest: %v %+v %s", err, latest, lv.Data)
	}
}

func TestSaveUpdatesTimestamp(t *testing.T) {
	s := open(t)
	d := create(t, s, "ts")
	got, _, err := s.Save(ctx, d.ID, 0, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if !got.UpdatedAt.After(d.UpdatedAt) || !got.CreatedAt.Equal(d.CreatedAt) {
		t.Fatalf("timestamps: created %v/%v updated %v/%v", d.CreatedAt, got.CreatedAt, d.UpdatedAt, got.UpdatedAt)
	}
}

func TestSaveConflict(t *testing.T) {
	s := open(t)
	d := create(t, s, "conflict")
	if _, _, err := s.Save(ctx, d.ID, 1, json.RawMessage(`{"n":2}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Save(ctx, d.ID, 1, json.RawMessage(`{"n":3}`)); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("got %v, want ErrConflict", err)
	}
	vs, _ := s.Versions(ctx, d.ID)
	if len(vs) != 2 {
		t.Fatalf("conflicting save wrote a version: %+v", vs)
	}
	// baseVersion 0 means "don't check".
	if _, _, err := s.Save(ctx, d.ID, 0, json.RawMessage(`{"n":3}`)); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentSavesGetDistinctVersions(t *testing.T) {
	s := open(t)
	d := create(t, s, "concurrent")
	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := s.Save(ctx, d.ID, 0, json.RawMessage(`{}`))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	vs, err := s.Versions(ctx, d.ID)
	if err != nil || len(vs) != n+1 {
		t.Fatalf("got %d versions (%v), want %d", len(vs), err, n+1)
	}
}

func TestSaveValidation(t *testing.T) {
	s := open(t)
	d := create(t, s, "invalid save")
	if _, _, err := s.Save(ctx, d.ID, 0, json.RawMessage(`[1]`)); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("got %v, want ErrInvalid", err)
	}
}

func TestNotFound(t *testing.T) {
	s := open(t)
	const id = 1 << 40
	if _, _, err := s.Get(ctx, id); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Get: %v", err)
	}
	if _, err := s.GetVersion(ctx, id, 1); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetVersion: %v", err)
	}
	if _, err := s.Versions(ctx, id); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Versions: %v", err)
	}
	if _, _, err := s.Save(ctx, id, 0, json.RawMessage(`{}`)); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Save: %v", err)
	}
	if err := s.Rename(ctx, id, "x"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Rename: %v", err)
	}
	if err := s.Delete(ctx, id); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Delete: %v", err)
	}
	d := create(t, s, "exists")
	if _, err := s.GetVersion(ctx, d.ID, 99); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetVersion of missing version: %v", err)
	}
}

func TestRename(t *testing.T) {
	s := open(t)
	d := create(t, s, "before")
	if err := s.Rename(ctx, d.ID, " after "); err != nil {
		t.Fatal(err)
	}
	// Renaming to the same name is not "not found".
	if err := s.Rename(ctx, d.ID, "after"); err != nil {
		t.Fatal(err)
	}
	got, _, err := s.Get(ctx, d.ID)
	if err != nil || got.Name != "after" || got.Version != 1 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if err := s.Rename(ctx, d.ID, " "); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("got %v, want ErrInvalid", err)
	}
}

func TestListOrdersByUpdate(t *testing.T) {
	s := open(t)
	a := create(t, s, "list a")
	b := create(t, s, "list b")
	if _, _, err := s.Save(ctx, a.ID, 0, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	all, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ia, ib := -1, -1
	for i, d := range all {
		switch d.ID {
		case a.ID:
			ia = i
			if d.Version != 2 {
				t.Errorf("a version %d, want 2", d.Version)
			}
		case b.ID:
			ib = i
		}
	}
	if ia < 0 || ib < 0 || ia > ib {
		t.Fatalf("want a (updated last) before b; got positions %d, %d", ia, ib)
	}
}

func TestDeleteCascadesToVersions(t *testing.T) {
	s := open(t)
	d := create(t, s, "delete me")
	if _, _, err := s.Save(ctx, d.ID, 0, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetVersion(ctx, d.ID, 1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("version survived delete: %v", err)
	}
}

func TestDataRoundTripsUnicode(t *testing.T) {
	s := open(t)
	data := `{"name":"cœurf ♥ 日本語 🎨"}`
	d, _, err := s.Create(ctx, "unicode ♥", json.RawMessage(data))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Delete(ctx, d.ID) })
	got, v, err := s.Get(ctx, d.ID)
	if err != nil || got.Name != "unicode ♥" || string(v.Data) != data {
		t.Fatalf("got %q %s (%v)", got.Name, v.Data, err)
	}
}

func TestOpenTwiceReappliesSchema(t *testing.T) {
	d := create(t, open(t), "survives reopen")
	if _, _, err := open(t).Get(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
}
