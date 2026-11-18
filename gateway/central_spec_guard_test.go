package main

import (
	"os"
	"path/filepath"
	"testing"
)

// centralFixture lays out main's checkout and a slot pool whose `current/main`
// link names slot-3, each holding central's server dir, on a registry that
// deploys main.
type centralFixture struct {
	reg      *Registry
	regDir   string
	checkout string
	slot     string
}

const centralRel = "plugins/framework/plugins/central-core"

func newCentralFixture(t *testing.T, linked bool) centralFixture {
	t.Helper()
	reg, regDir := newTestRegistry(t)
	base := t.TempDir()
	checkout := filepath.Join(base, "repo")
	pool := filepath.Join(base, "services", "main-slots")
	slot := filepath.Join(pool, "slot-3")
	for _, d := range []string{
		filepath.Join(checkout, centralRel),
		filepath.Join(slot, centralRel),
		filepath.Join(pool, "slot-4", centralRel),
		filepath.Join(pool, "current"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(pool, "current", "main")
	if linked {
		if err := os.Symlink(slot, current); err != nil {
			t.Fatal(err)
		}
	}
	reg.cfg.MainCheckout = checkout
	reg.cfg.MainSlotsCurrent = current
	if err := os.MkdirAll(filepath.Join(regDir, "central"), 0o755); err != nil {
		t.Fatal(err)
	}
	return centralFixture{reg: reg, regDir: regDir, checkout: checkout, slot: slot}
}

func (f centralFixture) writeCentral(t *testing.T, server string) {
	t.Helper()
	writeSpecAtomic(t, filepath.Join(f.regDir, "central", "spec.json"), `{"server":"`+server+`"}`)
}

func (f centralFixture) server(t *testing.T) string {
	t.Helper()
	wt := f.reg.Get(centralNamespace)
	if wt == nil {
		return ""
	}
	return resolvedPath(wt.Spec().Server)
}

// The 2026-11-17 case: central runs from slot-3, and a worktree build from
// before the slots rewrites its spec to the repo root. The gateway keeps the
// slot.
func TestCentralSpecFromCheckoutRefusedOnceSlotsServe(t *testing.T) {
	f := newCentralFixture(t, true)
	inSlot := filepath.Join(f.slot, centralRel)
	f.writeCentral(t, inSlot)
	f.reg.reconcileOnce()
	if got := f.server(t); got != resolvedPath(inSlot) {
		t.Fatalf("central should register from its slot, got %q", got)
	}

	f.writeCentral(t, filepath.Join(f.checkout, centralRel))
	f.reg.reconcileOnce()
	f.reg.RefreshSpec(centralNamespace)
	if got := f.server(t); got != resolvedPath(inSlot) {
		t.Fatalf("a spec naming the checkout must not move central off its slot, got %q", got)
	}

	// Main's build moving central to another slot is still applied.
	other := filepath.Join(filepath.Dir(f.slot), "slot-4", centralRel)
	f.writeCentral(t, other)
	f.reg.reconcileOnce()
	if got := f.server(t); got != resolvedPath(other) {
		t.Fatalf("a spec naming another slot should apply, got %q", got)
	}
}

// A gateway booting over a refused file registers central from the same path
// in main's served slot rather than from the checkout.
func TestCentralSpecFromCheckoutRebasedAtBoot(t *testing.T) {
	f := newCentralFixture(t, true)
	f.writeCentral(t, filepath.Join(f.checkout, centralRel))
	if err := f.reg.LoadAll(); err != nil {
		t.Fatal(err)
	}
	if got, want := f.server(t), resolvedPath(filepath.Join(f.slot, centralRel)); got != want {
		t.Fatalf("central should be rebased into the served slot: got %q want %q", got, want)
	}
}

// Outside both the pool and main's checkout there is nothing to rebase onto:
// central is registered as written rather than left down.
func TestCentralSpecElsewhereRegisteredAtBoot(t *testing.T) {
	f := newCentralFixture(t, true)
	elsewhere := filepath.Join(t.TempDir(), "x")
	if err := os.MkdirAll(elsewhere, 0o755); err != nil {
		t.Fatal(err)
	}
	f.writeCentral(t, elsewhere)
	f.reg.reconcileOnce()
	if got := f.server(t); got != resolvedPath(elsewhere) {
		t.Fatalf("central should be registered as written, got %q", got)
	}
}

// Before main's first slot build there is no link: central legitimately runs
// from the checkout.
func TestCentralSpecUnguardedBeforeSlots(t *testing.T) {
	f := newCentralFixture(t, false)
	inCheckout := filepath.Join(f.checkout, centralRel)
	f.writeCentral(t, inCheckout)
	f.reg.reconcileOnce()
	if got := f.server(t); got != resolvedPath(inCheckout) {
		t.Fatalf("central should register from the checkout, got %q", got)
	}
}
