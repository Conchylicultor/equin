package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
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
// ("/home"), "" for every other path; and the pages that may frame an app's
// shell, keyed by its base path (shell/document-head's
// DocumentHead.FrameAncestors). A file from a backend that predates
// frameAncestors has none, and every shell is served without the header, as
// before.
type documentHead struct {
	V              int                 `json:"v"`
	Entries        map[string]string   `json:"entries"`
	FrameAncestors map[string][]string `json:"frameAncestors"`
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
	if key, found := matchAppPath(entries, urlPath); found {
		return entries[key]
	}
	return entries[""]
}

// matchAppPath is the longest non-"" key of m that urlPath is in — the key
// itself or a path under it at a segment boundary, after collapsing repeated
// slashes — or found=false.
func matchAppPath[V any](m map[string]V, urlPath string) (key string, found bool) {
	for strings.Contains(urlPath, "//") {
		urlPath = strings.ReplaceAll(urlPath, "//", "/")
	}
	for k := range m {
		if k == "" {
			continue
		}
		if urlPath != k && !strings.HasPrefix(urlPath, k+"/") {
			continue
		}
		if !found || len(k) > len(key) {
			key, found = k, true
		}
	}
	return key, found
}

// cspSourceRe is one CSP source expression: nothing that would end the
// directive (whitespace separates sources, but a source with any in it was
// not written as one), start another (;) or another policy (,).
var cspSourceRe = regexp.MustCompile(`^[^\s;,]+$`)

// frameAncestorsPolicy is the Content-Security-Policy the shell for urlPath
// is served under — `frame-ancestors <sources>` for the longest app path the
// file names — or ok=false when none names it (the shell carries no CSP). A
// policy the gateway cannot use as written (no sources, or one that is not a
// single source expression; the backend's writer refuses both) fails closed,
// `frame-ancestors 'none'`, logged: it was meant to restrict framing.
func frameAncestorsPolicy(head documentHead, urlPath string) (string, bool) {
	key, found := matchAppPath(head.FrameAncestors, urlPath)
	if !found {
		return "", false
	}
	sources := head.FrameAncestors[key]
	if len(sources) == 0 {
		slog.Error("document head: frame-ancestors policy has no sources", "path", key)
		return "frame-ancestors 'none'", true
	}
	for _, s := range sources {
		if !cspSourceRe.MatchString(s) {
			slog.Error("document head: frame-ancestors source is not one source expression", "path", key, "source", s)
			return "frame-ancestors 'none'", true
		}
	}
	return "frame-ancestors " + strings.Join(sources, " "), true
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

// shellHead is what the namespace's document-head.json says about the shell
// for this request path: the head fragment to splice (matchDocumentHead; ""
// when there is none) and the Content-Security-Policy to serve it under
// (frameAncestorsPolicy; "" when none). Both empty when there is no file or
// one this gateway cannot read (logged).
func shellHead(wt *Worktree, urlPath string) (fragment, csp string) {
	if wt.cfg == nil || wt.cfg.RegistryDir == "" {
		return "", ""
	}
	head, ok := readDocumentHead(filepath.Join(wt.cfg.RegistryDir, wt.Name, documentHeadFile))
	if !ok {
		return "", ""
	}
	csp, _ = frameAncestorsPolicy(head, urlPath)
	return matchDocumentHead(head.Entries, urlPath), csp
}
