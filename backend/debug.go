package main

import (
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Debug routes list and clear the chunk cache. They answer 404 unless the
// DEBUG_TOKEN environment variable is set, and then require it as a bearer token.

// cacheMeta is the sidecar file written next to each cached MP3.
type cacheMeta struct {
	Voice   string  `json:"voice"`
	Speed   float64 `json:"speed"`
	Text    string  `json:"text"`
	Created string  `json:"created"`
}

type cacheEntry struct {
	Key     string  `json:"key"`
	Voice   string  `json:"voice"`
	Speed   float64 `json:"speed"`
	Preview string  `json:"preview"`
	Bytes   int64   `json:"bytes"`
	Created string  `json:"created"`
}

const previewChars = 60

func writeCacheMeta(path string, voice string, speed float64, text string) error {
	data, err := json.Marshal(cacheMeta{
		Voice:   voice,
		Speed:   speed,
		Text:    text,
		Created: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	return os.WriteFile(strings.TrimSuffix(path, ".mp3")+".json", data, 0o644)
}

func isCacheKey(key string) bool {
	_, err := hex.DecodeString(key)
	return err == nil && len(key) == 64
}

func (s *server) debugAuthorized(r *http.Request) bool {
	if s.debugToken == "" {
		return false
	}
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header[len(prefix):]), []byte(s.debugToken)) == 1
}

// requireDebug writes the error and reports false unless the debug route is enabled and the token matches.
func (s *server) requireDebug(w http.ResponseWriter, r *http.Request) bool {
	if s.debugToken == "" {
		http.NotFound(w, r)
		return false
	}
	if !s.debugAuthorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func (s *server) handleDebugList(w http.ResponseWriter, r *http.Request) {
	if !s.requireDebug(w, r) {
		return
	}
	entries, err := s.listCache()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot read cache")
		return
	}
	var total int64
	for _, e := range entries {
		total += e.Bytes
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"count":   len(entries),
		"bytes":   total,
		"entries": entries,
	})
}

func (s *server) handleDebugDeleteOne(w http.ResponseWriter, r *http.Request) {
	if !s.requireDebug(w, r) {
		return
	}
	key := r.PathValue("key")
	if !isCacheKey(key) {
		writeError(w, http.StatusBadRequest, "key must be 64 hex characters")
		return
	}
	base := filepath.Join(s.cacheDir, key[:2], key)
	if err := removeIfExists(base + ".mp3"); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	removeIfExists(base + ".json")
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleDebugClear(w http.ResponseWriter, r *http.Request) {
	if !s.requireDebug(w, r) {
		return
	}
	entries, err := s.listCache()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot read cache")
		return
	}
	for _, e := range entries {
		base := filepath.Join(s.cacheDir, e.Key[:2], e.Key)
		if err := removeIfExists(base + ".mp3"); err != nil {
			writeError(w, http.StatusInternalServerError, "delete failed")
			return
		}
		removeIfExists(base + ".json")
	}
	w.WriteHeader(http.StatusNoContent)
}

// listCache returns every cached MP3, newest first. A file without its sidecar is listed with empty fields.
func (s *server) listCache() ([]cacheEntry, error) {
	entries := []cacheEntry{}
	dirs, err := os.ReadDir(s.cacheDir)
	if os.IsNotExist(err) {
		return []cacheEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		if !dir.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(s.cacheDir, dir.Name()))
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			name := f.Name()
			if !strings.HasSuffix(name, ".mp3") {
				continue
			}
			key := strings.TrimSuffix(name, ".mp3")
			if !isCacheKey(key) {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			entry := cacheEntry{Key: key, Bytes: info.Size(), Created: info.ModTime().UTC().Format(time.RFC3339)}
			if data, err := os.ReadFile(filepath.Join(s.cacheDir, dir.Name(), key+".json")); err == nil {
				var meta cacheMeta
				if json.Unmarshal(data, &meta) == nil {
					entry.Voice = meta.Voice
					entry.Speed = meta.Speed
					entry.Preview = preview(meta.Text)
					entry.Created = meta.Created
				}
			}
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Created > entries[j].Created })
	return entries, nil
}

func preview(text string) string {
	if utf8.RuneCountInString(text) <= previewChars {
		return text
	}
	return string([]rune(text)[:previewChars]) + "…"
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
