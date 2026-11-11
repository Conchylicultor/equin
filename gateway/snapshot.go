package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// The static snapshot of a crawlable composition's pages: what a reader that
// runs no JavaScript (a crawler, an AI agent's fetch) gets of a page, hidden
// from every browser that does. The snapshot build writes it into the web dist
// (`<web>/snapshot/`); the gateway splices it into the shell for the paths the
// manifest lists. Design: research/2026-11-10-global-website-crawlable-v3.md
// (and v2 § Serving).

// snapshotManifestPath is where the manifest sits inside a web dist — the Go
// spelling of crawlable's SNAPSHOT_MANIFEST_PATH
// (plugins/apps/plugins/website/plugins/crawlable/core).
const snapshotManifestPath = "snapshot/manifest.json"

// snapshotRootTag is the shell's React mount point; the snapshot goes right
// after it, so it is the body's first visible content when JS does not run.
const snapshotRootTag = `<div id="root"></div>`

// snapshotHideHead hides the snapshot from every reader that runs JS: the
// script marks the document before the body is parsed, so the snapshot is
// never painted (no flash). A stylesheet rule rather than `hidden` or
// <noscript>, which Readability-style extractors drop.
const snapshotHideHead = `<style>html.js #equin-snapshot{display:none}</style>` +
	`<script>document.documentElement.classList.add("js")</script>`

// snapshotManifest mirrors crawlable's SnapshotManifestSchema — strictly: an
// unknown field is an error (DisallowUnknownFields), so writer and reader
// change together.
type snapshotManifest struct {
	Pages map[string]snapshotManifestPage `json:"pages"`
	// Home is the path bare `/` goes to (the composition's home app's base
	// path), absent for a composition with no home: never "/" itself, always
	// one of Pages. Raw, so an explicit null — which the schema's optional
	// refuses — is told apart from absence.
	Home json.RawMessage `json:"home"`
}

type snapshotManifestPage struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	File        string `json:"file"`
}

// snapshotPage is one listed page, its fragment read: what the splice needs.
type snapshotPage struct {
	title       string
	description string
	fragment    []byte
	// err is set when the manifest lists the page but its fragment cannot be
	// served (missing, unreadable): that path fails, the others still serve.
	err error
}

// snapshotSet is one manifest revision, every fragment read with it. err is
// set when the manifest itself is unusable; then no path can be trusted.
type snapshotSet struct {
	pages map[string]snapshotPage
	// home is where `GET /` is redirected (301), "" for none.
	home string
	err  error
}

// snapshotCache holds one loaded manifest per web dir (the stable symlink in
// spec.json), until the resolved dist or the manifest's revision changes. A
// build swaps the symlink to a new dist dir, so a build is always a miss; a
// shell request otherwise costs a readlink and a stat. The entry for a web dir
// is replaced, never accumulated, so the cache is bounded by the namespaces.
var snapshotCache = struct {
	sync.Mutex
	byWeb map[string]cachedSnapshot
}{byWeb: map[string]cachedSnapshot{}}

type cachedSnapshot struct {
	dist string
	rev  specRev
	set  snapshotSet
}

// readSnapshot returns the dist's snapshot set, or ok=false when it has none
// (no manifest: a composition that is not crawlable — today's shell). A set
// whose err is set is a manifest that exists but cannot be used.
func readSnapshot(webDir string) (snapshotSet, bool) {
	// Read the manifest and its fragments from the resolved dist, so one load
	// never mixes two builds when the symlink flips under it.
	dist, err := filepath.EvalSymlinks(webDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return snapshotSet{}, false
		}
		return snapshotSet{err: fmt.Errorf("resolve %s: %w", webDir, err)}, true
	}
	manifestFile := filepath.Join(dist, filepath.FromSlash(snapshotManifestPath))
	info, err := os.Stat(manifestFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return snapshotSet{}, false
		}
		return snapshotSet{err: fmt.Errorf("stat %s: %w", manifestFile, err)}, true
	}
	rev := specRevOf(info)

	snapshotCache.Lock()
	cached, hit := snapshotCache.byWeb[webDir]
	snapshotCache.Unlock()
	if hit && cached.dist == dist && cached.rev == rev {
		return cached.set, true
	}

	set := loadSnapshot(manifestFile)
	if set.err != nil {
		// Logged once per revision (the cache keeps the failure too), not per request.
		logSnapshotError(manifestFile, set.err)
	}
	for p, page := range set.pages {
		if page.err != nil {
			logSnapshotError(manifestFile, fmt.Errorf("page %s: %w", p, page.err))
		}
	}
	snapshotCache.Lock()
	snapshotCache.byWeb[webDir] = cachedSnapshot{dist: dist, rev: rev, set: set}
	snapshotCache.Unlock()
	return set, true
}

// loadSnapshot parses the manifest and reads every listed fragment.
func loadSnapshot(manifestFile string) snapshotSet {
	raw, err := os.ReadFile(manifestFile)
	if err != nil {
		return snapshotSet{err: fmt.Errorf("read: %w", err)}
	}
	manifest, err := parseSnapshotManifest(raw)
	if err != nil {
		return snapshotSet{err: err}
	}
	dir := filepath.Dir(manifestFile)
	pages := make(map[string]snapshotPage, len(manifest.Pages))
	for p, entry := range manifest.Pages {
		page := snapshotPage{title: entry.Title, description: entry.Description}
		fragment, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(entry.File)))
		if err != nil {
			page.err = fmt.Errorf("fragment %s: %w", entry.File, err)
		} else {
			page.fragment = fragment
		}
		pages[p] = page
	}
	home, _ := manifestHome(manifest)
	return snapshotSet{pages: pages, home: home}
}

// parseSnapshotManifest decodes the manifest the way SnapshotManifestSchema
// parses it: unknown fields refused at both levels, `pages` required, keys
// absolute paths with no trailing slash (or "/"), title and description
// non-empty, file a `.html` path relative to the manifest's dir that never
// escapes it; `home`, when present, a page path other than "/" that `pages`
// lists.
func parseSnapshotManifest(raw []byte) (snapshotManifest, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var m snapshotManifest
	if err := dec.Decode(&m); err != nil {
		return snapshotManifest{}, fmt.Errorf("unparseable: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return snapshotManifest{}, errors.New("unparseable: trailing data after the manifest")
	}
	if m.Pages == nil {
		return snapshotManifest{}, errors.New(`no "pages" object`)
	}
	for p, entry := range m.Pages {
		if !validSnapshotPath(p) {
			return snapshotManifest{}, fmt.Errorf("page %q: not an absolute page path without a trailing slash", p)
		}
		if entry.Title == "" || entry.Description == "" {
			return snapshotManifest{}, fmt.Errorf("page %q: empty or missing title or description", p)
		}
		if !validSnapshotFile(entry.File) {
			return snapshotManifest{}, fmt.Errorf("page %q: file %q is not a .html path inside the snapshot dir", p, entry.File)
		}
	}
	if home, err := manifestHome(m); err != nil {
		return snapshotManifest{}, err
	} else if m.Home != nil {
		if !validSnapshotPath(home) || home == "/" {
			return snapshotManifest{}, fmt.Errorf("home %q: not an absolute page path other than /", home)
		}
		if _, listed := m.Pages[home]; !listed {
			return snapshotManifest{}, fmt.Errorf("home %q: no page of the snapshot", home)
		}
	}
	return m, nil
}

// manifestHome decodes the manifest's home: "" when absent, an error when it
// is present but not a string (null included).
func manifestHome(m snapshotManifest) (string, error) {
	if m.Home == nil {
		return "", nil
	}
	if bytes.Equal(bytes.TrimSpace(m.Home), []byte("null")) {
		return "", errors.New("home: null (omit it for no home)")
	}
	var home string
	if err := json.Unmarshal(m.Home, &home); err != nil {
		return "", fmt.Errorf("home: not a string: %w", err)
	}
	return home, nil
}

func validSnapshotPath(p string) bool {
	if p == "/" {
		return true
	}
	return strings.HasPrefix(p, "/") && !strings.HasSuffix(p, "/") && !strings.ContainsAny(p, "?#")
}

func validSnapshotFile(f string) bool {
	if !strings.HasSuffix(f, ".html") || strings.HasPrefix(f, "/") || strings.Contains(f, `\`) {
		return false
	}
	for _, seg := range strings.Split(f, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

func logSnapshotError(manifestFile string, err error) {
	slog.Error("snapshot: unusable", "manifest", manifestFile, "err", err)
}

// snapshotRequestPath is the manifest key a request path looks up: cleaned
// (repeated slashes collapsed, dot segments resolved) and with no trailing
// slash, so `/website/download/` is `/website/download`. The query is never
// part of it (r.URL.Path).
func snapshotRequestPath(urlPath string) string {
	return path.Clean("/" + urlPath)
}

// The forwarding headers: what the visitor addressed, as the gateway relays it
// to a backend (newReverseProxy) and reads it for the canonical link.
const (
	forwardedHostHeader  = "X-Forwarded-Host"
	forwardedProtoHeader = "X-Forwarded-Proto"
)

// requestOrigin is the origin the visitor addressed: the Host header under the
// scheme a TLS proxy in front of the gateway reports in X-Forwarded-Proto
// (its first hop), http otherwise — the gateway itself only speaks http. The
// same rule as crawlable's requestOrigin on the backend.
func requestOrigin(host, forwardedProto string) string {
	scheme := "http"
	if first, _, _ := strings.Cut(forwardedProto, ","); strings.EqualFold(strings.TrimSpace(first), "https") {
		scheme = "https"
	}
	return scheme + "://" + host
}

// spliceSnapshot puts one page's snapshot into the shell: its title (replacing
// the shell's own <title>, or added when the shell has none), description,
// canonical link and the hiding rule before </head>, and the fragment, wrapped
// in #equin-snapshot, right after the root div. Errors when the shell lacks a
// </head> or the root div: a listed page that cannot carry its snapshot fails.
func spliceSnapshot(index []byte, page snapshotPage, canonical string) ([]byte, error) {
	headEnd := bytes.Index(index, []byte("</head>"))
	if headEnd < 0 {
		return nil, errors.New("the shell has no </head>")
	}
	rootAt := bytes.Index(index, []byte(snapshotRootTag))
	if rootAt < headEnd {
		return nil, fmt.Errorf("the shell has no %s in its body", snapshotRootTag)
	}
	rootEnd := rootAt + len(snapshotRootTag)

	title := "<title>" + html.EscapeString(page.title) + "</title>"
	headAdd := `<meta name="description" content="` + html.EscapeString(page.description) + `">` +
		`<link rel="canonical" href="` + html.EscapeString(canonical) + `">` +
		snapshotHideHead

	// The head up to </head>, its <title> replaced.
	head := index[:headEnd]
	var out bytes.Buffer
	out.Grow(len(index) + len(title) + len(headAdd) + len(page.fragment) + 64)
	if open := bytes.Index(head, []byte("<title>")); open >= 0 {
		closeAt := bytes.Index(head[open:], []byte("</title>"))
		if closeAt < 0 {
			return nil, errors.New("the shell's <title> is not closed in its head")
		}
		out.Write(head[:open])
		out.WriteString(title)
		out.Write(head[open+closeAt+len("</title>"):])
	} else {
		out.Write(head)
		out.WriteString(title)
	}
	out.WriteString(headAdd)
	out.Write(index[headEnd:rootEnd])
	out.WriteString(`<div id="equin-snapshot">`)
	out.Write(page.fragment)
	out.WriteString(`</div>`)
	out.Write(index[rootEnd:])
	return out.Bytes(), nil
}
