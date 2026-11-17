package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// ─── the environment every child process starts from ─────────
//
// The gateway used to hand each child its OWN environment plus a few additions
// (`append(os.Environ(), "SOCKET_PATH=…")`), and the exec sites that set no Env
// at all got the same thing implicitly: a nil Cmd.Env in Go means "inherit
// everything". The gateway's own environment is whatever its starter carried.
// Started from an agent shell, that was the shell's EQUIN_CONVERSATION_ID
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
var errChildEnvRequired = errors.New("-child-env is required — start the gateway with ./equin start, " +
	"which declares the runtime environment (launcher/core runtimeEnvNames); to hand-run it, " +
	"pass at least -child-env HOME,USER,PATH")

// parseChildEnvFlag splits the -child-env flag into its declared entries.
// Each entry is a variable name, or a name prefix ending in `*`
// (`EQUIN_AUTH_*`).
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
// values can be credentials (EQUIN_AUTH_*), and the log is not a secret
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

// Plus returns a ChildEnv whose base also carries extra (`NAME=value`
// entries, replacing same-named ones): an addition the gateway makes for
// EVERY child, rather than one child's own (With).
func (c ChildEnv) Plus(extra ...string) ChildEnv {
	return ChildEnv{base: c.With(extra...)}
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

// CommandContext is Command bound to ctx: when ctx ends the process is
// stopped by the caller's cmd.Cancel (exec's default: kill the process alone).
func (c ChildEnv) CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = c.With()
	return cmd
}

// runtimeChildEnv is the base every child starts from: the captured
// declared environment plus what the gateway itself decides for every child —
// the data root's layout (dataroot.go) and EQUIN_GATEWAY_PORT, the port this
// gateway serves on (-listen's). A backend, central and a deploy run read
// their gateway's port from it, so they always agree with the gateway that
// spawned them, whatever any file says. Set here, never forwarded: a value
// the starter carried is replaced.
func runtimeChildEnv(captured ChildEnv, gatewayPort int) ChildEnv {
	return captured.Plus(append(dataRootLayoutEnv(), gatewayPortEntry(gatewayPort))...)
}

// gatewayPortEntry is the EQUIN_GATEWAY_PORT entry for port, in decimal.
func gatewayPortEntry(port int) string {
	return envPrefix + "GATEWAY_PORT=" + strconv.Itoa(port)
}

// ─── the app's own variables, by key ─────────────────────────
//
// The Go twin of readEnv in plugins/infra/plugins/launcher/plugins/env-names
// (env.ts): each of the app's variables is named EQUIN_<key>. An empty value
// counts as unset, as os.Getenv always did here.
const envPrefix = "EQUIN_"

// readEnv returns the value of the app variable `key`, or "" when it is unset.
func readEnv(key string) string {
	return os.Getenv(envPrefix + key)
}

// ─── the exec sites of long-lived children (spawn.go, keeper.go) ─────────

// startChild starts a long-lived child from its spec — the environment is the
// spec's own, always explicit (a nil Env would inherit this process's). The
// write ends of its output pipes are closed here once it holds them, so the
// read ends reach EOF when it (and whatever it started) exits. A goroutine
// waits for it and closes done with its status.
func startChild(s spawnSpec) (*child, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("spawn: empty argv")
	}
	cmd := exec.Command(s.Argv[0], s.Argv[1:]...)
	cmd.Env = append([]string{}, s.Env...)
	cmd.Dir = s.Dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	outW, outR, err := openOutput(s.Stdout)
	if err != nil {
		return nil, fmt.Errorf("stdout: %w", err)
	}
	errW, errR, err := openOutput(s.Stderr)
	if err != nil {
		closeFiles(outW, outR)
		return nil, fmt.Errorf("stderr: %w", err)
	}
	if outW != nil {
		cmd.Stdout = outW
	}
	if errW != nil {
		cmd.Stderr = errW
	}
	err = cmd.Start()
	// The child holds its own copies of the write ends.
	closeFiles(outW, errW)
	if err != nil {
		closeFiles(outR, errR)
		return nil, err
	}
	c := &child{Pid: cmd.Process.Pid, Stdout: outR, Stderr: errR, done: make(chan struct{})}
	go func() {
		werr := cmd.Wait()
		c.exited(statusOf(cmd.ProcessState, werr))
	}()
	return c, nil
}

func closeFiles(fs ...*os.File) {
	for _, f := range fs {
		if f != nil {
			_ = f.Close()
		}
	}
}

// startGeneration starts one gateway generation for the keeper: binary and
// args from its launch, the launch's own environment (explicit), the keeper's
// stdout/stderr (the service's stdio log), and extra as fd 3, 4, …. Not its
// own process group: a service manager stopping the keeper's group stops it
// with the keeper.
func startGeneration(binary string, args, env []string, dir string, extra []*os.File) (*exec.Cmd, error) {
	cmd := exec.Command(binary, args...)
	cmd.Env = append([]string{}, env...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = extra
	return cmd, cmd.Start()
}

// keeperOwnEnvironment is the keeper's whole environment: what its first
// generation starts with, exactly as a gateway with no keeper ran with it. A
// later generation runs with the environment its handover named.
func keeperOwnEnvironment() []string {
	return os.Environ()
}
