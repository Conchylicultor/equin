package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// centralNamespace is central's registry name: the one API runtime every
// namespace shares, run from main's code.
const centralNamespace = "central"

// Central's spec, guarded on the receiving side.
//
// Once main serves from its slot pool (plugins/infra/plugins/git/plugins/main-slots),
// central runs from a slot, and only main's own build writes its spec — always
// naming a slot. A worktree checkout that branched before the slots landed still
// writes central's spec on EVERY build, naming the repo root (its
// `getMainRepoRoot()`): on 2026-11-17 one moved central's spec off slot-3, the
// slot central kept running from, so that slot read as draining (a false
// main-slot-drain-slow report) and a respawn would have booted central from the
// checkout `./equin push` rewrites. Old checkouts keep running their old code
// until they rebase, so the refusal has to live here.
//
// The rule, on a gateway that deploys main (-main-checkout) once main's
// `current` link (-main-slots-current) resolves to a slot: a central spec whose
// `server` is not inside that slot's pool is refused.
//
//   - Central already registered: its spec stays exactly as loaded (a respawn
//     boots what it ran). Main's next build rewrites the file to the slot central
//     runs from (build/cli/run.ts).
//   - Not registered yet (a gateway booting over a refused file): the spec is
//     read as naming the same path in the slot main is served from — when its
//     `server` lies in main's checkout, the one place such a writer names.
//     Anything else is registered as written, logged at error: an
//     unregistered central would be stopped at a handover (adopt.go).
//
// A refused revision is logged once; the reconcile tick re-reads it (its
// revision is not the loaded one) without logging again.

// centralSlotPool returns main's served slot and the pool it sits in, both
// resolved, or ok=false when the guard does not apply: no main deploy on this
// gateway, or no slot serving main yet (before main's first slot build, central
// legitimately runs from the checkout).
func centralSlotPool(cfg *Config) (slot, pool string, ok bool) {
	if cfg.MainCheckout == "" || cfg.MainSlotsCurrent == "" {
		return "", "", false
	}
	slot, err := filepath.EvalSymlinks(cfg.MainSlotsCurrent)
	if err != nil {
		return "", "", false
	}
	if fi, err := os.Stat(slot); err != nil || !fi.IsDir() {
		return "", "", false
	}
	// Slots are the pool's direct children (`<pool>/slot-<n>`).
	return slot, filepath.Dir(slot), true
}

// resolvedPath is path with its symlinks resolved, or cleaned as spelled when
// it cannot be (a path that does not exist).
func resolvedPath(path string) string {
	if r, err := filepath.EvalSymlinks(path); err == nil {
		return r
	}
	return filepath.Clean(path)
}

// pathWithin reports whether path is dir itself or inside it.
func pathWithin(dir, path string) bool {
	return path == dir || strings.HasPrefix(path, dir+string(filepath.Separator))
}

// guardCentralSpec judges a freshly loaded central spec. It returns the spec to
// apply (spec itself, or a copy rebased into main's served slot), or nil when
// nothing is to be applied.
func (r *Registry) guardCentralSpec(spec *Spec) *Spec {
	slot, pool, ok := centralSlotPool(r.cfg)
	if !ok {
		return spec
	}
	server := resolvedPath(spec.Server)
	if pathWithin(pool, server) {
		return spec
	}
	logOnce := r.noteRefusedCentralRev(spec.rev)
	if r.Get(centralNamespace) != nil {
		if logOnce {
			slog.Warn("central spec refused: it names a tree outside main's slot pool (a build from before main's slots wrote it); central keeps the spec it runs from",
				"server", spec.Server, "pool", pool)
		}
		return nil
	}
	checkout := resolvedPath(r.cfg.MainCheckout)
	if rel, err := filepath.Rel(checkout, server); err == nil && pathWithin(checkout, server) {
		rebased := *spec
		rebased.Server = filepath.Join(slot, rel)
		if logOnce {
			slog.Warn("central spec names main's checkout, outside main's slot pool (a build from before main's slots wrote it); central is registered from the same path in main's served slot",
				"server", spec.Server, "rebased", rebased.Server)
		}
		return &rebased
	}
	// Nothing to rebase onto. Registered as written, loudly: leaving central
	// unregistered would stop a running central at a handover (adopt.go stops
	// a backend whose worktree does not resolve) — an outage over a path.
	if logOnce {
		slog.Error("central spec names a tree outside main's slot pool and outside main's checkout; registered as written until main's build writes its spec",
			"server", spec.Server, "pool", pool)
	}
	return spec
}

// noteRefusedCentralRev records rev as the last refused central revision and
// reports whether it is a new one (so its refusal is logged once).
func (r *Registry) noteRefusedCentralRev(rev specRev) bool {
	r.refusedMu.Lock()
	defer r.refusedMu.Unlock()
	if r.refusedCentralRev == rev {
		return false
	}
	r.refusedCentralRev = rev
	return true
}
