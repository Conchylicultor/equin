package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// documentHeadFile is what the backend renders into the SPA shell's <head>
// before the first frame — today the theme's CSS — per app path, written to
// the namespace's own data dir beside spec.json. The TypeScript side names it
// once in `worktreeArtifacts.documentHead` (infra/paths); this is the Go
// spelling of the same name. Written atomically (temp + rename) by
// shell/document-head's machine half, at boot and whenever a source changes.
const documentHeadFile = "document-head.json"

// documentHead is the file's schema: head HTML keyed by an app's base path
// ("/home"), "" for every other path.
type documentHead struct {
	V       int               `json:"v"`
	Entries map[string]string `json:"entries"`
}

// documentHeadCache keeps each parsed file until its revision changes, so a
// shell request costs one stat rather than a parse of the whole file.
var documentHeadCache = struct {
	sync.Mutex
	byPath map[string]cachedDocumentHead
}{byPath: map[string]cachedDocumentHead{}}

type cachedDocumentHead struct {
	rev  specRev
	head documentHead
}

// readDocumentHead returns the namespace's head fragments, or ok=false when
// there are none to splice: no file yet (a backend that has never booted) or
// one this gateway cannot read. The latter is logged loudly; the page is still
// served — unthemed for one frame — rather than failed.
func readDocumentHead(file string) (documentHead, bool) {
	info, err := os.Stat(file)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Error("document head: stat failed", "file", file, "err", err)
		}
		return documentHead{}, false
	}
	// The same fingerprint spec.json gets: the writer renames a new inode in.
	rev := specRevOf(info)

	documentHeadCache.Lock()
	cached, hit := documentHeadCache.byPath[file]
	documentHeadCache.Unlock()
	if hit && cached.rev == rev {
		return cached.head, true
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		slog.Error("document head: read failed", "file", file, "err", err)
		return documentHead{}, false
	}
	var head documentHead
	if err := json.Unmarshal(raw, &head); err != nil {
		slog.Error("document head: unparseable", "file", file, "err", err)
		return documentHead{}, false
	}
	if head.V != 1 {
		slog.Error("document head: unknown version", "file", file, "v", head.V)
		return documentHead{}, false
	}
	documentHeadCache.Lock()
	documentHeadCache.byPath[file] = cachedDocumentHead{rev: rev, head: head}
	documentHeadCache.Unlock()
	return head, true
}

// matchDocumentHead picks the entry for a request path the way the app router
// picks an app: the longest key that is the path itself or a prefix of it at a
// segment boundary, else "". Repeated slashes are collapsed first, as the
// router's normalizeRoutePath does, so `//home` still matches "/home".
func matchDocumentHead(entries map[string]string, urlPath string) string {
	for strings.Contains(urlPath, "//") {
		urlPath = strings.ReplaceAll(urlPath, "//", "/")
	}
	best := ""
	found := false
	for key := range entries {
		if key == "" {
			continue
		}
		if urlPath != key && !strings.HasPrefix(urlPath, key+"/") {
			continue
		}
		if !found || len(key) > len(best) {
			best, found = key, true
		}
	}
	if found {
		return entries[best]
	}
	return entries[""]
}

// spliceHead inserts fragment before the shell's </head>. ok=false when the
// shell has no </head> to put it before.
func spliceHead(index []byte, fragment string) ([]byte, bool) {
	at := bytes.Index(index, []byte("</head>"))
	if at < 0 {
		return nil, false
	}
	out := make([]byte, 0, len(index)+len(fragment))
	out = append(out, index[:at]...)
	out = append(out, fragment...)
	out = append(out, index[at:]...)
	return out, true
}

// serveShellWithHead serves index.html with the namespace's head fragment for
// this path spliced in, and reports whether it did. It declines (false) when
// there is nothing to splice, leaving the caller's plain file serve.
//
// The bytes now vary by path and by the fragment, so the file's own
// validators no longer describe them: the ETag is a hash of the bytes served,
// which keeps an unchanged page a bodiless 304 and makes a theme change a 200.
func serveShellWithHead(w http.ResponseWriter, r *http.Request, wt *Worktree, indexPath string) bool {
	if wt.cfg == nil || wt.cfg.RegistryDir == "" {
		return false
	}
	head, ok := readDocumentHead(filepath.Join(wt.cfg.RegistryDir, wt.Name, documentHeadFile))
	if !ok {
		return false
	}
	fragment := matchDocumentHead(head.Entries, r.URL.Path)
	if fragment == "" {
		return false
	}
	index, err := os.ReadFile(indexPath)
	if err != nil {
		// The plain serve reports it the way it always has.
		return false
	}
	body, ok := spliceHead(index, fragment)
	if !ok {
		slog.Error("document head: shell has no </head>", "index", indexPath)
		return false
	}
	sum := fnv.New64a()
	_, _ = sum.Write(body)
	w.Header().Set("ETag", fmt.Sprintf(`"dh-%x"`, sum.Sum64()))
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(body))
	return true
}
