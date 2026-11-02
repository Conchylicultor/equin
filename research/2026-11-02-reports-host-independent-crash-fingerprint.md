# Host-independent crash fingerprint

**Date:** 2026-11-02 · **Plugin:** `reports/crash` (`core/crash-kind.ts`)

## Problem

A framed crash's fingerprint is `sha256(errorType | top 3 normalized frames)`.
`normalizeFrames` stripped only line:col and dev cache-busters, so each frame
still carried where the code was served from and which build of it ran:

- **The origin** — `https://<namespace>.localhost:9000/…`. The same bug hashed
  differently per namespace, and the product-rename sweep (e1d036882b), which
  moved main's public host, moved every browser crash's identity (it showed up
  as the pinned hash in `crash-kind.test.ts` breaking).
- **The artifact content hash** — `/artifacts/network.live.web.<16 hex>/index.js`.
  Every rebuild of an artifact minted new identities for its crashes. On main
  this had already split real rows, e.g. `Notification action kind "fix-report"
  is not registered` on `8ce919badd84fd31` and `327d39269598d015`, and the
  `conversations-gone` decode error on `88abcb6f3f3c0bfc` / `df94a450c2f0ffea`.
- **The checkout prefix** — `/Users/…/repo/.claude/worktrees/<id>/plugins/…` in
  server stacks.

Re-pinning the test's hash would have hidden all three.

## Fix

A frame's identity is now its function and its app-relative file. Normalization
also strips the URL origin (any `scheme://authority`), any 16-hex content-hash
path segment (artifact dirs, vendor sets, package assets), and the absolute path
prefix up to the first `/plugins/`, `/node_modules/` or `/NM/`. The test pins the
normalized form and asserts one identity across hosts, builds and checkouts.

## Existing rows: no migration

Rows are keyed `(fingerprint, worktree)`. Changing branch 1's input gives every
framed crash a new fingerprint once. We do not re-fingerprint or merge the
existing rows:

- Browser rows were already effectively per-build (the artifact hash), so their
  old fingerprints would not have matched a recurrence after the next build
  anyway.
- Unlinked rows (`task_id IS NULL`, all automatic telemetry) are swept after 7
  days by `reportsRetention`. On main, 81 framed crash rows existed at the cut,
  42 of them unlinked.
- Linked rows (39, 8 seen in the last week) are kept by retention and keep
  their task. A recurrence lands on a fresh row, which alerts once. Re-running
  the frame parsing in SQL to rewrite fingerprints in a data migration would
  duplicate the normalizer in a second language for a one-time saving of a few
  re-alerts, so it is not worth it.

Branches 2 (declared `errorType`) and 3 (message) are unchanged and their pins
stay.
