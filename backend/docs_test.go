package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenAPIListsEveryEndpoint(t *testing.T) {
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openAPISpec, &spec); err != nil {
		t.Fatalf("openapi.json is not valid JSON: %v", err)
	}
	for _, e := range endpoints {
		if _, ok := spec.Paths[e.Path][strings.ToLower(e.Method)]; !ok {
			t.Errorf("openapi.json is missing %s %s", e.Method, e.Path)
		}
	}
	if got, want := len(spec.Paths), len(uniquePaths()); got != want {
		t.Errorf("openapi.json has %d paths, endpoints list has %d", got, want)
	}
}

func TestRootReturnsJSONWhenAsked(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept", "application/json")
	rec := httptest.NewRecorder()
	handleRoot(rec, req)

	var got indexData
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("root JSON invalid: %v", err)
	}
	if got.Status != "ok" || len(got.Endpoints) != len(endpoints) {
		t.Errorf("unexpected index: %+v", got)
	}
}

func uniquePaths() map[string]bool {
	paths := map[string]bool{}
	for _, e := range endpoints {
		paths[e.Path] = true
	}
	return paths
}
