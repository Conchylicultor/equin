# Auto-provision Playwright's chromium binary so the e2e screenshot helper never breaks

**Date:** 2026-06-16
**Category:** global (root `package.json` + `e2e/`)

## Context

`e2e/screenshot.mjs` — the sanctioned helper agents use to capture/verify the app —
and every other `e2e/*.mjs` script + `sidequests/ui-mastery/scripts/*.mjs` import
`from "playwright"` and call `chromium.launch()`. They currently break with a
chromium build mismatch: the resolved Playwright version expects a chromium
revision that isn't present locally, so `chromium.launch()` hard-errors
(`Executable doesn't exist… Run npx playwright install`). In an agent's
non-interactive shell this fails outright. The current per-agent workaround —
manually overriding `executablePath` to a Chrome-for-Testing binary — is fragile
and has to be re-discovered by every agent.

### Root cause (confirmed)

The Playwright **npm package** and its **browser binary** are provisioned by two
separate, drifting mechanisms:

- **Package:** `package.json` pins `"playwright": "^1.60.0"`. The top-level
  `./equin` shell script runs `bun install --silent` on *every* invocation,
  and `build.ts` step 1 runs `bun install` too — so the package tracks the caret
  range and can move to the latest 1.x.
- **Binary:** each Playwright minor hard-pins one chromium revision
  (1.59.1→1217, 1.60.0→1223, 1.61.x→1228). The binary lives in the **global,
  shared** cache `~/Library/Caches/ms-playwright/chromium-<rev>` and is provisioned
  **only** by an explicit `playwright install` — which **nothing in this repo ever
  runs**. Installed locally: only `chromium-1217` and `chromium-1223`.

So the moment the resolved Playwright version's expected revision isn't already in
the global cache, every Playwright consumer breaks at once. A targeted fix in
`screenshot.mjs` (e.g. an `executablePath` override) leaves all the sibling
scripts and the bare `bunx playwright screenshot` path (documented in `CLAUDE.md`)
exposed.

### Intended outcome

Provision the chromium binary by the **same mechanism that provisions the npm
package**, so the two can never drift. Version-agnostic and self-healing: whatever
Playwright version `bun install` resolves, the matching chromium is fetched
automatically and silently. We deliberately **keep the `^` caret** (always get the
latest patches) — the auto-provisioning is what makes that drift safe. The fix
must be a **true noop in the steady state** (no added latency on normal
`./equin` calls).

## Approach

### 1. Self-healing provisioning script — `e2e/ensure-chromium.mjs` (new)

A tiny idempotent script that uses Playwright's own API to find where the matching
chromium *should* be, and only downloads when it's actually missing:

```js
// e2e/ensure-chromium.mjs
// Ensures the chromium revision the currently-resolved Playwright expects is
// present in the shared browser cache. Noop fast-path when already installed.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

// executablePath() is a pure getter — it computes the path (respecting
// PLAYWRIGHT_BROWSERS_PATH and the OS default cache dir) without launching or
// requiring the binary to exist. Safe to call when chromium is absent.
const exe = chromium.executablePath();
if (existsSync(exe)) process.exit(0); // steady state: one stat, then exit

console.log(`Playwright chromium not found at ${exe} — installing…`);
execFileSync("bunx", ["playwright", "install", "chromium"], { stdio: "inherit" });
```

Notes:
- **Import `playwright-core`, not `playwright`** — it's the lighter package (no
  test-runner graph) and still exposes `chromium.executablePath()`. Keeps the
  noop path cheap.
- `chromium` only — no `--with-deps` (a no-op on macOS/darwin; only meaningful on
  Linux apt). The full chromium bundle is what `chromium.launch()` uses; we do not
  need to separately fetch `chromium_headless_shell`.
- Loud download (`stdio: "inherit"`) only on the cold path; silent otherwise. Bun
  lifecycle-script output is *not* suppressed by `bun install --silent`, so a real
  download stays visible.

### 2. Wire it as a root `postinstall` hook — `package.json`

```jsonc
{
  "scripts": {
    // …
    "postinstall": "bun e2e/ensure-chromium.mjs"
  }
}
```

- Bun always runs the **root** package's own `postinstall` after `bun install`
  completes — this is **not** gated by `trustedDependencies` (that gate only
  applies to third-party dependency scripts). At that point `playwright-core` is
  present in `node_modules`, so the import resolves.
- Fires on every `./equin` call (via `bun install --silent`) and on build
  step 1 — universal coverage, including bare `bun e2e/…` and
  `bunx playwright screenshot` runs done without a full build.

### Why this stays a noop / adds no per-worktree latency

- The chromium cache `~/Library/Caches/ms-playwright/` is **global and shared
  across all worktrees and Playwright versions**. The first worktree on a machine
  (per revision) downloads once; every other worktree's guard finds the binary and
  exits after a single `existsSync`.
- The steady-state cost is one short bun-script spawn doing an import + one stat —
  dwarfed by the `bun install` that always immediately precedes it. No download, no
  network, no browser launch.
- Concurrent first-installs across worktrees (e.g. parallel agents) are safe:
  `playwright install chromium` is idempotent and re-completes a partial dir.

### 3. Keep `"playwright": "^1.60.0"` (no pin change)

Per the requirement to always have the latest patches, we **keep the caret**. The
self-healing provisioning makes version drift safe: when the caret resolves to a
newer minor with a new chromium revision, the postinstall fetches it automatically
on the next `bun install`.

## Files

- **New:** `e2e/ensure-chromium.mjs` — the idempotent provisioning guard.
- **Modified:** `package.json` (root) — add the `postinstall` script. No change to
  the `playwright` version range.
- **No change:** `e2e/screenshot.mjs` and sibling scripts — they keep importing
  `playwright` unchanged and now Just Work. No `executablePath` override anywhere.
- **No change:** `plugins/framework/plugins/cli/bin/commands/build.ts` — postinstall
  covers the build path via its `bun install` step; a separate build.ts step would
  be redundant (rejected as over-engineering).

## Verification

End-to-end, on this worktree:

1. **Cold path (forces a real install):** temporarily move the matching cache dir
   aside, then run the guard and confirm it downloads and exits 0:
   ```bash
   # find the expected path
   bun -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())'
   # move its chromium-<rev> dir aside, then:
   bun e2e/ensure-chromium.mjs        # should print "installing…" and download
   ```
2. **Noop path:** run it again — it must print nothing and exit 0 immediately
   (`echo $?` → 0), confirming the steady-state guard is a pure stat.
3. **postinstall wiring:** run `bun install` at the repo root and confirm the guard
   runs as part of it (cold: downloads; warm: silent).
4. **Real consumer:** with the app built (`./equin build`), capture a
   screenshot through the helper and confirm it produces the PNG without any manual
   `executablePath` override:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000 --out /tmp/shot
   # → wrote /tmp/shot-before.png
   ```
5. **Deploy:** `./equin build` — confirm the build's `bun install` step
   triggers the postinstall guard and the build completes normally.
