// Package store persists designs and their immutable version history in a
// MySQL-compatible database (MariaDB or MySQL).
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var (
	// ErrNotFound is returned when a design or version does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict is returned when a save is based on a version that is no
	// longer the latest one.
	ErrConflict = errors.New("version conflict")
	// ErrInvalid is returned for bad input (empty name, non-object data, ...).
	ErrInvalid = errors.New("invalid input")
)

const maxNameLen = 255

// Design is a named document. Version is its latest version number.
type Design struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Version is one immutable snapshot of a design. Data is only populated when
// a single version is fetched, not when versions are listed.
type Version struct {
	DesignID  int64           `json:"design_id"`
	Version   int             `json:"version"`
	CreatedAt time.Time       `json:"created_at"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// Store is the repository. It is safe for concurrent use.
type Store struct {
	db *sql.DB
}

// Open connects to the database described by dsn and applies the schema.
// The DSN must include parseTime=true.
func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// Close releases the database connections.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks that the database is reachable.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// Statements are idempotent, so they can run on every start.
var schema = []string{
	`CREATE TABLE IF NOT EXISTS designs (
		id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
		name       VARCHAR(255) NOT NULL,
		created_at DATETIME(6) NOT NULL,
		updated_at DATETIME(6) NOT NULL,
		KEY designs_updated_at (updated_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE IF NOT EXISTS design_versions (
		design_id  BIGINT UNSIGNED NOT NULL,
		version    INT UNSIGNED NOT NULL,
		data       LONGTEXT NOT NULL,
		created_at DATETIME(6) NOT NULL,
		PRIMARY KEY (design_id, version),
		CONSTRAINT design_versions_design FOREIGN KEY (design_id)
			REFERENCES designs (id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
}

func (s *Store) migrate(ctx context.Context) error {
	for _, stmt := range schema {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func validate(name string, data json.RawMessage) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > maxNameLen {
		return fmt.Errorf("%w: name must be 1-%d characters", ErrInvalid, maxNameLen)
	}
	return validateData(data)
}

func validateData(data json.RawMessage) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil || obj == nil {
		return fmt.Errorf("%w: data must be a JSON object", ErrInvalid)
	}
	return nil
}

// Create stores a new design with data as its first version.
func (s *Store) Create(ctx context.Context, name string, data json.RawMessage) (Design, Version, error) {
	name = strings.TrimSpace(name)
	if err := validate(name, data); err != nil {
		return Design{}, Version{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Design{}, Version{}, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`INSERT INTO designs (name, created_at, updated_at) VALUES (?, ?, ?)`, name, now, now)
	if err != nil {
		return Design{}, Version{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Design{}, Version{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO design_versions (design_id, version, data, created_at) VALUES (?, 1, ?, ?)`,
		id, string(data), now); err != nil {
		return Design{}, Version{}, err
	}
	if err := tx.Commit(); err != nil {
		return Design{}, Version{}, err
	}
	return Design{ID: id, Name: name, Version: 1, CreatedAt: now, UpdatedAt: now},
		Version{DesignID: id, Version: 1, CreatedAt: now, Data: data}, nil
}

// Save appends data as a new version of the design. If baseVersion is
// non-zero it must equal the current latest version, otherwise ErrConflict is
// returned and nothing is written (optimistic concurrency).
func (s *Store) Save(ctx context.Context, id int64, baseVersion int, data json.RawMessage) (Design, Version, error) {
	if err := validateData(data); err != nil {
		return Design{}, Version{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Design{}, Version{}, err
	}
	defer tx.Rollback()
	// Locking the design row serializes concurrent saves of the same design.
	var d Design
	err = tx.QueryRowContext(ctx,
		`SELECT id, name, created_at FROM designs WHERE id = ? FOR UPDATE`, id).
		Scan(&d.ID, &d.Name, &d.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Design{}, Version{}, ErrNotFound
	}
	if err != nil {
		return Design{}, Version{}, err
	}
	var latest int
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(version) FROM design_versions WHERE design_id = ?`, id).Scan(&latest); err != nil {
		return Design{}, Version{}, err
	}
	if baseVersion != 0 && baseVersion != latest {
		return Design{}, Version{}, ErrConflict
	}
	latest++
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO design_versions (design_id, version, data, created_at) VALUES (?, ?, ?, ?)`,
		id, latest, string(data), now); err != nil {
		return Design{}, Version{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE designs SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return Design{}, Version{}, err
	}
	if err := tx.Commit(); err != nil {
		return Design{}, Version{}, err
	}
	d.Version, d.UpdatedAt = latest, now
	return d, Version{DesignID: id, Version: latest, CreatedAt: now, Data: data}, nil
}

// Rename changes a design's name without creating a version.
func (s *Store) Rename(ctx context.Context, id int64, name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > maxNameLen {
		return fmt.Errorf("%w: name must be 1-%d characters", ErrInvalid, maxNameLen)
	}
	// RowsAffected is 0 for an unchanged name, so check existence separately.
	if _, err := s.db.ExecContext(ctx, `UPDATE designs SET name = ? WHERE id = ?`, name, id); err != nil {
		return err
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM designs WHERE id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete removes a design together with all its versions.
func (s *Store) Delete(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM designs WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrNotFound
	}
	return nil
}

const designSelect = `SELECT d.id, d.name, d.created_at, d.updated_at,
	(SELECT MAX(version) FROM design_versions v WHERE v.design_id = d.id)
	FROM designs d`

// List returns all designs, most recently updated first.
func (s *Store) List(ctx context.Context) ([]Design, error) {
	rows, err := s.db.QueryContext(ctx, designSelect+` ORDER BY d.updated_at DESC, d.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Design{}
	for rows.Next() {
		var d Design
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.UpdatedAt, &d.Version); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Get returns a design with its latest version, data included.
func (s *Store) Get(ctx context.Context, id int64) (Design, Version, error) {
	var d Design
	err := s.db.QueryRowContext(ctx, designSelect+` WHERE d.id = ?`, id).
		Scan(&d.ID, &d.Name, &d.CreatedAt, &d.UpdatedAt, &d.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return Design{}, Version{}, ErrNotFound
	}
	if err != nil {
		return Design{}, Version{}, err
	}
	v, err := s.GetVersion(ctx, id, d.Version)
	return d, v, err
}

// GetVersion returns one version of a design, data included.
func (s *Store) GetVersion(ctx context.Context, id int64, version int) (Version, error) {
	v := Version{DesignID: id}
	var data string
	err := s.db.QueryRowContext(ctx,
		`SELECT version, data, created_at FROM design_versions WHERE design_id = ? AND version = ?`,
		id, version).Scan(&v.Version, &data, &v.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Version{}, ErrNotFound
	}
	if err != nil {
		return Version{}, err
	}
	v.Data = json.RawMessage(data)
	return v, nil
}

// Versions lists a design's versions, newest first, without their data.
func (s *Store) Versions(ctx context.Context, id int64) ([]Version, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT version, created_at FROM design_versions WHERE design_id = ? ORDER BY version DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		v := Version{DesignID: id}
		if err := rows.Scan(&v.Version, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}
