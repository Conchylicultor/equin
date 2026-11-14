package main

import (
	"strings"
	"testing"
	"time"
)

// idleRunningWorktree registers a worktree whose backend is running, holds no
// connection and has been idle for an hour — what the sweeper stops.
func idleRunningWorktree(t *testing.T, reg *Registry, name string) *Worktree {
	t.Helper()
	wt, err := NewWorktree(name, &Spec{Server: "/tmp/server"}, reg.cfg)
	if err != nil {
		t.Fatalf("NewWorktree: %v", err)
	}
	sock := wt.primarySocketPath()
	bk := &backend{exitCh: make(chan struct{}), socketPath: sock, proxy: newReverseProxy(sock)}
	wt.mu.Lock()
	wt.phase = runningOn(bk)
	wt.lastActivity = time.Now().Add(-time.Hour)
	wt.mu.Unlock()
	return wt
}

// The namespace a gateway serves at its public hosts is never swept for
// idleness; every other one is, and a gateway with no public hosts sweeps its
// default namespace like any other (a desktop app, a preview).
func TestSweepSparesThePublicNamespace(t *testing.T) {
	cases := []struct {
		name        string
		publicHosts string
		site        bool // whether the default namespace is swept
	}{
		{"deployed site", "equin.ai,www.equin.ai", false},
		{"no public hosts", "", true},
		{"blank public hosts", " , ", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &Config{
				SocketsDir:       shortTempDir(t),
				IdleTimeout:      10 * time.Minute,
				DefaultNamespace: "website",
				PublicHosts:      c.publicHosts,
				ChildEnv:         testChildEnv(t),
			}
			reg := NewRegistry(cfg)
			site := idleRunningWorktree(t, reg, "website")
			other := idleRunningWorktree(t, reg, "other")
			if got := reg.sweepable(site); got != c.site {
				t.Fatalf("sweepable(default namespace) = %v, want %v", got, c.site)
			}
			if !reg.sweepable(other) {
				t.Fatal("a namespace the public hosts do not reach must still be swept")
			}
		})
	}
}

func TestPublicHostsNeedADefaultNamespace(t *testing.T) {
	cfg := &Config{PublicHosts: "equin.ai"}
	err := cfg.validatePublicServing()
	if err == nil || !strings.Contains(err.Error(), "-default-namespace") {
		t.Fatalf("validatePublicServing = %v, want a refusal naming -default-namespace", err)
	}
	for _, ok := range []Config{{}, {DefaultNamespace: "website"}, {PublicHosts: "equin.ai", DefaultNamespace: "website"}} {
		if err := ok.validatePublicServing(); err != nil {
			t.Fatalf("validatePublicServing(%+v) = %v, want nil", ok, err)
		}
	}
}
