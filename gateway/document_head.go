package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// documentHeadFragment is the namespace's head fragment for this request path
// (document-head.json's entry, matchDocumentHead), or "" when there is none to
// splice: no file, one this gateway cannot read (logged), or no entry.
func documentHeadFragment(wt *Worktree, urlPath string) string {
	if wt.cfg == nil || wt.cfg.RegistryDir == "" {
		return ""
	}
	head, ok := readDocumentHead(filepath.Join(wt.cfg.RegistryDir, wt.Name, documentHeadFile))
	if !ok {
		return ""
	}
	return matchDocumentHead(head.Entries, urlPath)
}
