package main

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// testChildEnv is the base environment for tests that build a Config or a
// Supervisor by hand: PATH and HOME from the test process, nothing else. A zero
// ChildEnv would give a spawned child an EMPTY environment (never "inherit"),
// so a test that spawns needs this — and declaring it explicitly keeps any test
// from silently depending on the implicit inherit the gateway no longer does.
func testChildEnv(t *testing.T) ChildEnv {
	t.Helper()
	env, _ := NewChildEnv([]string{"PATH", "HOME"}, os.Environ())
	return env
}

func TestParseChildEnvFlag(t *testing.T) {
	got, err := parseChildEnvFlag(" HOME, PATH ,EQUIN_AUTH_*")
	if err != nil {
		t.Fatalf("parseChildEnvFlag: %v", err)
	}
	if want := []string{"HOME", "PATH", "EQUIN_AUTH_*"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("declared = %q, want %q", got, want)
	}

	// Absent or blank is the "hand-run without the declaration" case: fatal,
	// with the message that names the fix.
	for _, raw := range []string{"", "   "} {
		if _, err := parseChildEnvFlag(raw); !errors.Is(err, errChildEnvRequired) {
			t.Fatalf("parseChildEnvFlag(%q) err = %v, want errChildEnvRequired", raw, err)
		}
	}
	if !strings.Contains(errChildEnvRequired.Error(), "./equin start") {
		t.Fatalf("required-flag error should name ./equin start, got %q", errChildEnvRequired)
	}

	// A malformed entry is an error, never skipped — and a bare `*` would be
	// inherit-everything under another name.
	for _, raw := range []string{"HOME,,PATH", "HOME,", "*", "HOME,*", "A=B", "A*B", "A**"} {
		if _, err := parseChildEnvFlag(raw); err == nil {
			t.Fatalf("parseChildEnvFlag(%q) should fail", raw)
		}
	}
}

// TestNewChildEnvKeepsOnlyDeclared is the incident regression: an agent
// shell's identity and terminal state (EQUIN_CONVERSATION_ID,
// CLAUDE_*) must not survive into the base, and must be reported as dropped.
func TestNewChildEnvKeepsOnlyDeclared(t *testing.T) {
	environ := []string{
		"HOME=/home/me",
		"EQUIN_CONVERSATION_ID=conv-1",
		"PATH=/usr/bin:/bin",
		"TERM_SESSION_ID=w0t0p0",
		"HOMEBREW_PREFIX=/opt/homebrew", // shares a prefix with HOME, but HOME is exact
		"EQUIN_AUTH_GOOGLE_CLIENT_ID=abc",
		"EQUIN_AUTHX=nope", // the prefix is EQUIN_AUTH_, underscore included
		"CLAUDE_CODE_SESSION_ID=s-1",
	}
	env, dropped := NewChildEnv([]string{"HOME", "PATH", "EQUIN_AUTH_*"}, environ)

	wantBase := []string{"HOME=/home/me", "PATH=/usr/bin:/bin", "EQUIN_AUTH_GOOGLE_CLIENT_ID=abc"}
	if got := env.With(); !reflect.DeepEqual(got, wantBase) {
		t.Fatalf("base = %q, want %q", got, wantBase)
	}
	wantDropped := []string{"EQUIN_CONVERSATION_ID", "TERM_SESSION_ID", "HOMEBREW_PREFIX", "EQUIN_AUTHX", "CLAUDE_CODE_SESSION_ID"}
	if !reflect.DeepEqual(dropped, wantDropped) {
		t.Fatalf("dropped = %q, want %q", dropped, wantDropped)
	}
	if got, want := env.Names(), []string{"HOME", "PATH", "EQUIN_AUTH_GOOGLE_CLIENT_ID"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Names() = %q, want %q", got, want)
	}
}

// TestChildEnvWithOverridesBase: a per-child value always wins over a
// same-named base entry, and the base is never mutated or aliased — the next
// child must start from the same base the last one did.
func TestChildEnvWithOverridesBase(t *testing.T) {
	env, _ := NewChildEnv([]string{"HOME", "SOCKET_PATH"}, []string{"HOME=/h", "SOCKET_PATH=/stale.sock"})

	got := env.With("SOCKET_PATH=/fresh.sock")
	if want := []string{"HOME=/h", "SOCKET_PATH=/fresh.sock"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("With = %q, want %q", got, want)
	}

	// Writing through a returned slice must not reach the base.
	got[0] = "HOME=/mutated"
	if base := env.With(); !reflect.DeepEqual(base, []string{"HOME=/h", "SOCKET_PATH=/stale.sock"}) {
		t.Fatalf("base changed after With: %q", base)
	}
}

// TestZeroChildEnvIsEmpty: a ChildEnv that was never threaded through means an
// empty environment, never Go's nil-Env inherit. Proven by running a child.
func TestZeroChildEnvIsEmpty(t *testing.T) {
	var env ChildEnv
	if got := env.With(); got == nil || len(got) != 0 {
		t.Fatalf("zero With() = %#v, want a non-nil empty slice", got)
	}
	t.Setenv("GATEWAY_ENV_TEST_LEAK", "leaked")
	out, err := env.Command("/usr/bin/env").Output()
	if err != nil {
		t.Fatalf("run env: %v", err)
	}
	if strings.TrimSpace(string(out)) != "" {
		t.Fatalf("zero ChildEnv child saw an environment:\n%s", out)
	}
}

// TestCommandSetsEnv: Command's child sees exactly the base — not the test
// process's own environment — and With's additions on top of it.
func TestCommandSetsEnv(t *testing.T) {
	t.Setenv("GATEWAY_ENV_TEST_LEAK", "leaked")
	env, _ := NewChildEnv([]string{"GATEWAY_ENV_TEST_KEPT"}, []string{"GATEWAY_ENV_TEST_KEPT=1", "GATEWAY_ENV_TEST_LEAK=leaked"})

	cmd := env.Command("/usr/bin/env")
	if cmd.Env == nil {
		t.Fatal("Command left Env nil, which Go reads as inherit-everything")
	}
	cmd.Env = env.With("SOCKET_PATH=/s.sock")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run env: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if want := []string{"GATEWAY_ENV_TEST_KEPT=1", "SOCKET_PATH=/s.sock"}; !reflect.DeepEqual(lines, want) {
		t.Fatalf("child env = %q, want %q", lines, want)
	}
}

// TestReadEnvBothNames: the current name wins, the legacy one is the fallback
// (an installed plist from an older `./equin start` sets only it), and the two
// set to different values is an error, never a guess.
func TestReadEnvBothNames(t *testing.T) {
	const key = "TEST_READ_ENV"
	current, legacy := envPrefix+key, legacyEnvPrefix+key
	cases := []struct {
		name, current, legacy, want string
		wantErr                     bool
	}{
		{"neither", "", "", "", false},
		{"current only", "a", "", "a", false},
		{"legacy only", "", "b", "b", false},
		{"both equal", "a", "a", "a", false},
		{"both differ", "a", "b", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(current, c.current)
			t.Setenv(legacy, c.legacy)
			got, err := readEnv(key)
			if (err != nil) != c.wantErr {
				t.Fatalf("readEnv err = %v, wantErr %v", err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("readEnv = %q, want %q", got, c.want)
			}
		})
	}
}
