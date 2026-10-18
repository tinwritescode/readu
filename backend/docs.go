package main

import (
	_ "embed"
	"encoding/json"
	"html/template"
	"net/http"
	"strings"
)

//go:embed openapi.json
var openAPISpec []byte

type endpoint struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Summary string `json:"summary"`
}

var endpoints = []endpoint{
	{"GET", "/", "Service index"},
	{"GET", "/healthz", "Health check"},
	{"GET", "/docs", "Swagger UI"},
	{"GET", "/openapi.json", "OpenAPI spec"},
	{"POST", "/v1/auth/code", "Email a login code"},
	{"POST", "/v1/auth/session", "Exchange code for a session token"},
	{"DELETE", "/v1/auth/session", "Log out"},
	{"GET", "/v1/voices", "List Vietnamese voices"},
	{"POST", "/v1/speech", "Synthesize speech"},
}

var indexPage = template.Must(template.New("index").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vtts-backend</title>
<style>
:root { --bg: #f6f7f9; --fg: #1b1f24; --muted: #5b6470; --card: #fff; --line: #dde1e7; --accent: #2563eb; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0f1216; --fg: #e6e9ee; --muted: #9aa4b2; --card: #171b21; --line: #2a313b; --accent: #7aa2ff; }
}
:root[data-theme="dark"] { --bg: #0f1216; --fg: #e6e9ee; --muted: #9aa4b2; --card: #171b21; --line: #2a313b; --accent: #7aa2ff; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 48px 16px; }
h1 { margin: 0 0 4px; font-size: 28px; }
.status { color: var(--muted); margin: 0 0 24px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 10px 6px; border-top: 1px solid var(--line); vertical-align: top; }
tr:first-child td { border-top: 0; }
code { font: 14px ui-monospace, monospace; }
.method { font-weight: 600; color: var(--accent); width: 64px; }
.links { margin-top: 20px; display: flex; gap: 16px; flex-wrap: wrap; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>{{.Name}}</h1>
<p class="status"><span class="dot"></span>{{.Status}}</p>
<div class="card">
<table>
{{range .Endpoints}}<tr><td class="method">{{.Method}}</td><td><code>{{.Path}}</code><br><span class="status">{{.Summary}}</span></td></tr>
{{end}}</table>
</div>
<div class="links">
<a href="/docs">Swagger UI</a>
<a href="/openapi.json">openapi.json</a>
</div>
</main>
</body>
</html>
`))

type indexData struct {
	Name      string     `json:"name"`
	Status    string     `json:"status"`
	Endpoints []endpoint `json:"endpoints"`
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	data := indexData{Name: "vtts-backend", Status: "ok", Endpoints: endpoints}
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(data)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	indexPage.Execute(w, data)
}

func handleOpenAPI(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(openAPISpec)
}

// swaggerPage loads Swagger UI from jsDelivr, pinned to a release.
const swaggerPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vtts-backend API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
</script>
</body>
</html>
`

func handleDocs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(swaggerPage))
}
