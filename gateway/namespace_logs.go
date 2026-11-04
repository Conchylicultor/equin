package main

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
)

// A namespace's log channel (`<log-dir>/<name>.log`, worktree.go) is bounded per
// file by its rotatingWriter, but the SET of files is only bounded if a
// namespace's files go away with the namespace. They do here: the gateway that
// writes them deletes them once the namespace's registry dir is gone — the
// same signal it already unregisters on (a reaped checkout or reclaimed
// composition removes `<registry-dir>/<name>/`). A registration evicted only
// because its server dir vanished keeps its logs: its registry dir still says
// the namespace exists.

// gatewayOwnChannels are the files in -log-dir that are not a namespace's:
// the gateway's own slog sink and the launcher's stdio capture.
var gatewayOwnChannels = map[string]bool{"gateway": true, "gateway-stdio": true}

// namespaceLogRe matches a channel file and its rotations: `<stem>.log`,
// `<stem>.log.<n>`.
var namespaceLogRe = regexp.MustCompile(`^(.+)\.log(\.[0-9]+)?$`)

// removeNamespaceLogs deletes `<name>.log` and every `<name>.log.<n>` in logDir.
func removeNamespaceLogs(logDir, name string) {
	matches, err := filepath.Glob(filepath.Join(logDir, globEscape(name)+".log*"))
	if err != nil {
		slog.Error("namespace logs: glob failed", "name", name, "err", err)
		return
	}
	for _, p := range matches {
		m := namespaceLogRe.FindStringSubmatch(filepath.Base(p))
		if m == nil || m[1] != name {
			continue
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("namespace logs: remove failed", "path", p, "err", err)
		}
	}
}

// registryDirGone reports whether name's registry dir is confirmed absent.
// ENOENT only: a transient stat error never deletes a live namespace's logs.
func registryDirGone(registryDir, name string) bool {
	_, err := os.Stat(filepath.Join(registryDir, name))
	return errors.Is(err, os.ErrNotExist)
}

// sweepOrphanNamespaceLogs deletes, once at boot, the log files of every
// namespace whose registry dir is gone — the namespaces reaped while no gateway
// was running to see it. Top-level files only: subdirs (`services/`) are not
// namespaces'.
func sweepOrphanNamespaceLogs(logDir, registryDir string) {
	entries, err := os.ReadDir(logDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Error("namespace logs: read log dir failed", "dir", logDir, "err", err)
		}
		return
	}
	gone := map[string]bool{}
	files := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := namespaceLogRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		name := m[1]
		if gatewayOwnChannels[name] || !validNamespace(name) {
			continue
		}
		dead, seen := gone[name]
		if !seen {
			dead = registryDirGone(registryDir, name)
			gone[name] = dead
		}
		if !dead {
			continue
		}
		if err := os.Remove(filepath.Join(logDir, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("namespace logs: remove failed", "file", e.Name(), "err", err)
			continue
		}
		files++
	}
	namespaces := 0
	for _, dead := range gone {
		if dead {
			namespaces++
		}
	}
	if files > 0 {
		slog.Info("namespace logs: removed the logs of namespaces with no registry dir", "namespaces", namespaces, "files", files)
	}
}

// globEscape escapes filepath.Match metacharacters. A valid namespace has
// none, but the function must not depend on its caller having checked.
func globEscape(s string) string {
	return globMetaRe.ReplaceAllString(s, `\$0`)
}

var globMetaRe = regexp.MustCompile(`[*?\[\]\\]`)
