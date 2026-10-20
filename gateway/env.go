package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ─── the environment every child process starts from ─────────
//
// The gateway used to hand each child its OWN environment plus a few additions
// (`append(os.Environ(), "SOCKET_PATH=…")`), and the exec sites that set no Env
// at all got the same thing implicitly: a nil Cmd.Env in Go means "inherit
// everything". The gateway's own environment is whatever its starter carried.
// Started from an agent shell, that was the shell's SINGULARITY_CONVERSATION_ID
// and CLAUDE_* — so every backend on the host (main, central, each
// worktree) ran as that one conversation, and so did everything they spawned:
// op-log records and commit trailers named it.
//
// So the environment a child gets is now DECLARED. The launcher passes the
// declared names as `-child-env` (from runtimeEnvNames() in
// plugins/infra/plugins/launcher/core); the gateway captures the matching part
// of its own environment once, at boot, and every child starts from exactly
// that plus its own named additions. Go holds no list of names of its own: a
// Go-side default would be a second copy of the declaration, free to drift.
//
// This file is the ONLY non-test file that may call os.Environ() or
// exec.Command (enforced by the launcher:gateway-env-explicit check), so no
// exec site can fall back to the implicit inherit by forgetting to set Env.

// ChildEnv is the base environment every gateway child starts from: the
// declared subset of the gateway's own environment, captured once at boot.
//
// The zero value is an EMPTY environment, never "inherit" — With and Command
// always return a non-nil Env, so a ChildEnv that was never threaded through
// fails visibly (a child with no PATH or HOME) instead of silently leaking.
type ChildEnv struct {
	base []string
}

// errChildEnvRequired is returned when -child-env is absent or empty. The
// message names the fix, since the usual way to hit it is hand-running the
// binary.
var errChildEnvRequired = errors.New("-child-env is required — start the gateway with ./singularity start, " +
	"which declares the runtime environment (launcher/core runtimeEnvNames); to hand-run it, " +
	"pass at least -child-env HOME,USER,PATH")

// parseChildEnvFlag splits the -child-env flag into its declared entries.
// Each entry is a variable name, or a name prefix ending in `*`
// (`SINGULARITY_AUTH_*`).
//
// Every malformed entry is an error rather than skipped: the flag is generated
// by the launcher, so a bad entry means the declaration and this parser
// disagree, and forwarding "whatever parsed" would hide it. A lone `*` is
// rejected because it would match every name — the inherit-everything this
// flag exists to end.
func parseChildEnvFlag(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errChildEnvRequired
	}
	parts := strings.Split(raw, ",")
	declared := make([]string, 0, len(parts))
	for _, p := range parts {
		entry := strings.TrimSpace(p)
		name := strings.TrimSuffix(entry, "*")
		switch {
		case entry == "":
			return nil, fmt.Errorf("-child-env %q: empty entry", raw)
		case name == "":
			return nil, fmt.Errorf("-child-env %q: a bare `*` would forward the whole environment", raw)
		case strings.ContainsAny(name, "=*"):
			return nil, fmt.Errorf("-child-env %q: entry %q is not a variable name or a NAME_* prefix", raw, entry)
		}
		declared = append(declared, entry)
	}
	return declared, nil
}

// NewChildEnv keeps the entries of environ (`NAME=value`, as os.Environ
// returns them) whose name is declared: equal to a declared name, or starting
// with a declared prefix (an entry ending in `*`). It returns the names it did
// not keep, so the caller can report what the starter carried that no child
// will see.
func NewChildEnv(declared []string, environ []string) (ChildEnv, []string) {
	exact := make(map[string]bool, len(declared))
	var prefixes []string
	for _, d := range declared {
		if prefix, ok := strings.CutSuffix(d, "*"); ok {
			prefixes = append(prefixes, prefix)
		} else {
			exact[d] = true
		}
	}
	matches := func(name string) bool {
		if exact[name] {
			return true
		}
		for _, p := range prefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
		return false
	}

	var env ChildEnv
	var dropped []string
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if matches(name) {
			env.base = append(env.base, kv)
		} else {
			dropped = append(dropped, name)
		}
	}
	return env, dropped
}

// captureChildEnv is the gateway's one read of its own environment: the
// declared subset becomes the base every child starts from.
func captureChildEnv(declared []string) (ChildEnv, []string) {
	return NewChildEnv(declared, os.Environ())
}

// Names returns the names in the base environment, for logging. Names only:
// values can be credentials (SINGULARITY_AUTH_*), and the log is not a secret
// store.
func (c ChildEnv) Names() []string {
	names := make([]string, 0, len(c.base))
	for _, kv := range c.base {
		name, _, _ := strings.Cut(kv, "=")
		names = append(names, name)
	}
	return names
}

// With returns the base environment plus extra (`NAME=value` entries). An
// extra replaces a same-named base entry rather than sitting beside it, so a
// value the gateway sets for one child always wins over
// one the starter happened to carry — even if the declaration ever grew to
// include that name.
//
// The result is a fresh, non-nil slice: it never aliases base (so a caller
// appending to it cannot corrupt the next child's environment), and it is
// never nil (so assigning it to Cmd.Env can never mean "inherit").
func (c ChildEnv) With(extra ...string) []string {
	overridden := make(map[string]bool, len(extra))
	for _, kv := range extra {
		name, _, _ := strings.Cut(kv, "=")
		overridden[name] = true
	}
	env := make([]string, 0, len(c.base)+len(extra))
	for _, kv := range c.base {
		name, _, _ := strings.Cut(kv, "=")
		if !overridden[name] {
			env = append(env, kv)
		}
	}
	return append(env, extra...)
}

// Command is exec.Command with Env set to the base environment — never left
// nil. A caller that needs additions sets `cmd.Env = c.With(…)` afterwards.
//
// The binary is still resolved against the gateway's own PATH (exec.Command's
// LookPath), which is fine: that PATH is itself a declared name.
func (c ChildEnv) Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Env = c.With()
	return cmd
}
