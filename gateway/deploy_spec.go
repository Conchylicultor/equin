package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ─── a spec: parsed, validated, and committed by a deploy ────
//
// spec.json has two writers. A build may write it and POST the restart route
// with no body (RefreshSpec adopts the file, then the restart boots it). Or the
// caller hands the gateway the spec in the restart's body, and the gateway is
// the file's one writer for that call: it boots the CANDIDATE and commits it —
// in memory and on disk — only once the candidate's backend is ready and
// serving. Until then nothing can see it: static serving reads wt.Spec().Web,
// a crash-respawn reads wt.Spec(), and both still hold the previous spec. A
// failed boot leaves both exactly as they were, so the next cold start (an
// idle sweep, then a request) boots what last worked, never the failed build.

// specFilePath is where a namespace's spec lives: <registry-dir>/<name>/spec.json.
func specFilePath(registryDir, name string) string {
	return filepath.Join(registryDir, name, "spec.json")
}

// parseSpec decodes and validates spec.json bytes — the one validation both a
// file load and a deploy's candidate go through. Unknown fields are ignored,
// as they always were (a newer writer may add one; see Composition).
func parseSpec(data []byte) (*Spec, error) {
	var spec Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if err := spec.validate(); err != nil {
		return nil, err
	}
	return &spec, nil
}

func (s *Spec) validate() error {
	if s.Server == "" {
		return errors.New("server is required")
	}
	if !filepath.IsAbs(s.Server) {
		return errors.New("server must be an absolute path")
	}
	// Web is optional — headless backends (e.g. central) have no UI bundle.
	if s.Web != "" && !filepath.IsAbs(s.Web) {
		return errors.New("web must be an absolute path when provided")
	}
	for k, v := range s.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return fmt.Errorf("env key %q is not a variable name (empty, or holds `=` or NUL)", k)
		}
		if strings.ContainsRune(v, 0) {
			return fmt.Errorf("env %s: value holds NUL", k)
		}
	}
	return nil
}

// envEntries is Spec.Env as `NAME=value` entries for ChildEnv.With, in name
// order so a spawn's environment is deterministic.
func (s *Spec) envEntries() []string {
	if len(s.Env) == 0 {
		return nil
	}
	out := make([]string, 0, len(s.Env))
	for k, v := range s.Env {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

// DeploySpec is a restart's candidate spec: parsed and validated, plus the
// exact bytes it came as — what commitSpec writes, so a field this gateway does
// not know (a newer build's) survives the round trip to spec.json, which the
// backend reads back itself.
type DeploySpec struct {
	spec *Spec
	raw  []byte
}

// parseDeploySpec validates a candidate exactly as a spec.json load would
// (loadSpec + loadFile's dead-server refusal).
func parseDeploySpec(raw []byte) (*DeploySpec, error) {
	spec, err := parseSpec(raw)
	if err != nil {
		return nil, err
	}
	if serverPathMissing(spec.Server) {
		return nil, fmt.Errorf("server %s does not exist", spec.Server)
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, raw, "", "  "); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	pretty.WriteByte('\n')
	return &DeploySpec{spec: spec, raw: pretty.Bytes()}, nil
}

// maxRestartBody bounds the restart route's body: a spec is a few hundred bytes.
const maxRestartBody = 1 << 20

// readRestartBody reads the restart route's optional body, `{"spec": <Spec>}`.
// No body (or only whitespace) → nil: today's write-the-file-then-POST form.
func readRestartBody(body io.Reader) (*DeploySpec, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxRestartBody+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if len(data) > maxRestartBody {
		return nil, fmt.Errorf("body exceeds %d bytes", maxRestartBody)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}
	var envelope struct {
		Spec json.RawMessage `json:"spec"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&envelope); err != nil {
		return nil, fmt.Errorf("body must be {\"spec\": {…}}: %w", err)
	}
	if len(envelope.Spec) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Spec), []byte("null")) {
		return nil, errors.New(`body must be {"spec": {…}}: spec is missing`)
	}
	cand, err := parseDeploySpec(envelope.Spec)
	if err != nil {
		return nil, fmt.Errorf("invalid spec: %w", err)
	}
	return cand, nil
}

// adoptSpec applies a spec the registry read from disk, unless it is the
// revision already in memory, or no longer the revision on disk (a deploy's
// commit replaced the file since it was read — adopting it would undo that
// commit; the next read picks up the current file). Returns the spec it
// replaced and whether it did.
func (w *Worktree) adoptSpec(spec *Spec, path string) (*Spec, bool) {
	w.specMu.Lock()
	defer w.specMu.Unlock()
	prev := w.spec.Load()
	if prev.rev == spec.rev {
		return prev, false
	}
	fi, err := os.Stat(path)
	if err != nil || specRevOf(fi) != spec.rev {
		return prev, false
	}
	w.spec.Store(spec)
	return prev, true
}

// commitSpec makes a deploy's candidate the worktree's spec: spec.json first
// (temp file + rename in the same dir), then memory, stamped with the written
// file's own revision — so RefreshSpec and the reconcile tick see the file as
// already loaded and never flip it again. Under specMu, so no registry read of
// an older revision lands in between or after. Its callers hold w.mu and call
// it in the same critical section that switches the proxy to the candidate's
// backend: the spec and the backend serving it change together. A write
// failure changes nothing (the temp file is removed).
func (w *Worktree) commitSpec(cand *DeploySpec) error {
	w.specMu.Lock()
	defer w.specMu.Unlock()
	if w.cfg.RegistryDir == "" {
		return errors.New("no registry dir to persist the spec in")
	}
	path := specFilePath(w.cfg.RegistryDir, w.Name)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".spec-*.json.tmp")
	if err != nil {
		return fmt.Errorf("write spec: %w", err)
	}
	written := false
	defer func() {
		if !written {
			_ = os.Remove(tmp.Name())
		}
	}()
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write spec: %w", err)
	}
	if _, err := tmp.Write(cand.raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write spec: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write spec: %w", err)
	}
	// The fd's own stat: the revision of exactly these bytes (a rename keeps
	// inode, size and mtime) — never a path stat another writer could race.
	fi, err := tmp.Stat()
	if err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write spec: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write spec: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write spec: %w", err)
	}
	written = true
	committed := *cand.spec
	committed.rev = specRevOf(fi)
	w.spec.Store(&committed)
	return nil
}
