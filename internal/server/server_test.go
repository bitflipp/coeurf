package server_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"coeurf/internal/server"
	"coeurf/internal/testdb"
)

var static = fstest.MapFS{
	"index.html": {Data: []byte("<h1>coeurf</h1>")},
	"app.js":     {Data: []byte("// app")},
}

type client struct {
	t   *testing.T
	url string
}

func newClient(t *testing.T) *client {
	t.Helper()
	ts := httptest.NewServer(server.New(static, testdb.Open(t)))
	t.Cleanup(ts.Close)
	return &client{t, ts.URL}
}

// do sends a request and returns the status and decoded JSON body (if any).
func (c *client) do(method, path, body string) (int, map[string]any) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.url+path, strings.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func (c *client) expect(want int, method, path, body string) map[string]any {
	c.t.Helper()
	got, out := c.do(method, path, body)
	if got != want {
		c.t.Fatalf("%s %s: status %d, want %d (%v)", method, path, got, want, out)
	}
	return out
}

// createDesign makes a design and removes it again when the test ends.
func (c *client) createDesign(name string) int {
	c.t.Helper()
	out := c.expect(201, "POST", "/api/designs", fmt.Sprintf(`{"name":%q,"data":{"v":1}}`, name))
	id := int(out["id"].(float64))
	c.t.Cleanup(func() { c.do("DELETE", fmt.Sprintf("/api/designs/%d", id), "") })
	return id
}

func TestStaticFiles(t *testing.T) {
	c := newClient(t)
	resp, err := http.Get(c.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "<h1>coeurf</h1>" {
		t.Fatalf("index: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
	}
	if resp, _ := http.Get(c.url + "/app.js"); resp.StatusCode != 200 {
		t.Fatalf("app.js: %d", resp.StatusCode)
	}
	if resp, _ := http.Get(c.url + "/nope.js"); resp.StatusCode != 404 {
		t.Fatalf("missing file: %d", resp.StatusCode)
	}
}

func TestConfigWithAndWithoutStorage(t *testing.T) {
	c := newClient(t)
	if out := c.expect(200, "GET", "/api/config", ""); out["storage"] != true {
		t.Fatalf("config = %v", out)
	}

	ts := httptest.NewServer(server.New(static, nil))
	defer ts.Close()
	off := &client{t, ts.URL}
	if out := off.expect(200, "GET", "/api/config", ""); out["storage"] != false {
		t.Fatalf("config = %v", out)
	}
	// Without storage the design API does not exist; unknown API paths are JSON 404s.
	off.expect(404, "GET", "/api/designs", "")
	off.expect(404, "POST", "/api/designs", `{}`)
}

func TestDesignLifecycle(t *testing.T) {
	c := newClient(t)
	id := c.createDesign("lifecycle")
	path := fmt.Sprintf("/api/designs/%d", id)

	out := c.expect(200, "GET", path, "")
	if out["name"] != "lifecycle" || out["version"] != 1.0 || out["latest"] != 1.0 {
		t.Fatalf("get: %v", out)
	}

	out = c.expect(200, "PUT", path, `{"data":{"v":2},"base_version":1}`)
	if out["version"] != 2.0 || out["latest"] != 2.0 {
		t.Fatalf("save: %v", out)
	}

	// A stale base version is rejected.
	c.expect(409, "PUT", path, `{"data":{"v":3},"base_version":1}`)

	// Old versions remain addressable; "latest" tells where the head is.
	out = c.expect(200, "GET", path+"/versions/1", "")
	if out["version"] != 1.0 || out["latest"] != 2.0 || out["data"].(map[string]any)["v"] != 1.0 {
		t.Fatalf("version 1: %v", out)
	}
	c.expect(404, "GET", path+"/versions/9", "")

	vs := c.versions(path)
	if len(vs) != 2 || vs[0].(map[string]any)["version"] != 2.0 {
		t.Fatalf("versions: %v", vs)
	}

	c.expect(204, "PATCH", path, `{"name":"renamed"}`)
	if out := c.expect(200, "GET", path, ""); out["name"] != "renamed" {
		t.Fatalf("rename: %v", out)
	}

	c.expect(204, "DELETE", path, "")
	c.expect(404, "GET", path, "")
	c.expect(404, "DELETE", path, "")
}

func (c *client) versions(path string) []any {
	c.t.Helper()
	resp, err := http.Get(c.url + path + "/versions")
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var vs []any
	if err := json.NewDecoder(resp.Body).Decode(&vs); err != nil {
		c.t.Fatal(err)
	}
	return vs
}

func TestList(t *testing.T) {
	c := newClient(t)
	id := c.createDesign("listed")
	resp, err := http.Get(c.url + "/api/designs")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	for _, d := range list {
		if int(d["id"].(float64)) == id {
			if d["name"] != "listed" || d["version"] != 1.0 {
				t.Fatalf("listed design: %v", d)
			}
			if _, has := d["data"]; has {
				t.Fatal("list must not include data")
			}
			return
		}
	}
	t.Fatalf("design %d not in list", id)
}

func TestBadRequests(t *testing.T) {
	c := newClient(t)
	id := c.createDesign("bad requests")
	path := fmt.Sprintf("/api/designs/%d", id)
	for _, tc := range []struct {
		name, method, path, body string
		want                     int
	}{
		{"malformed JSON", "POST", "/api/designs", `{`, 400},
		{"missing name", "POST", "/api/designs", `{"data":{}}`, 400},
		{"missing data", "POST", "/api/designs", `{"name":"x"}`, 400},
		{"non-object data", "POST", "/api/designs", `{"name":"x","data":[1]}`, 400},
		{"save non-object", "PUT", path, `{"data":"str"}`, 400},
		{"save to missing design", "PUT", "/api/designs/999999999999", `{"data":{}}`, 404},
		{"rename blank", "PATCH", path, `{"name":" "}`, 400},
		{"non-numeric id", "GET", "/api/designs/abc", "", 400},
		{"zero id", "GET", "/api/designs/0", "", 400},
		{"non-numeric version", "GET", path + "/versions/x", "", 400},
		{"unknown api path", "GET", "/api/other", "", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c.expect(tc.want, tc.method, tc.path, tc.body)
		})
	}
}

func TestTooLargeBody(t *testing.T) {
	c := newClient(t)
	big := `{"name":"big","data":{"x":"` + strings.Repeat("a", 17<<20) + `"}}`
	c.expect(413, "POST", "/api/designs", big)
}
