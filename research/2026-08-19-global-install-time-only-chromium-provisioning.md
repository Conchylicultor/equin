# Chromium provisioning becomes install-time-only, and unreachable from a request path

**Date:** 2026-08-19
**Category:** global (`browser-fetch`, `prototypes/thumbnails`, `e2e-harness`, `boundaries`)

## Context

`ensureChromium()` (`plugins/infra/plugins/safe-fetch/plugins/browser-fetch/core/internal/ensure-chromium.ts:53`)
ends in:

```ts
execFileSync("bunx", ["playwright", "install", "chromium"], { stdio: "inherit" });
```

No timeout. Steady state is one `existsSync` and it returns, so this only fires
when the binary is absent — a Playwright minor bump, or a fresh machine. When it
does fire from inside a backend it blocks the **entire event loop** for a ~150 MB
download with no ceiling: no health endpoint, no live-state, no jobs, and — the
part that makes it hard to diagnose — no queue-health watchdog either, because
that watchdog is a `setInterval` on the loop this blocks.

It is reachable from a runtime path today: `renderThumbnail()`
(`plugins/apps/plugins/prototypes/plugins/thumbnails/server/internal/render.ts:163`)
calls it as its **first** statement, ahead of every bound in that carefully
bounded file.

There is a second, sharper defect hiding in the same line. `ensureChromium()`
opens with an unbounded `await import("playwright")`. `render.ts` has its own
`loadPlaywright()` that bounds that import at 30 s (`MODULE_TIMEOUT_MS`) — but
the unbounded copy runs *first*, so the bound never arms. That is precisely the
wedge `browser-fetch`'s `deadline.ts` was written to prevent, quoting its own
doc comment: *"being the one unbounded `await` in the chain is what let a live
backend park a refresh job for hours."* The same shape is back, one plugin over.

**Intended outcome.** Downloading a browser is provisioning, and provisioning is
install-time work. After this change no request path can start that download —
not because the current caller was removed, but because the function is no
longer reachable from `server/`, `web/` or `core/` at all, and the boundary
check says so.

The precedent is already in the same plugin: `browserFetch` does **not**
self-install. A missing binary throws `browser-unavailable` with the remedy in
the message, and `browser-fetch/CLAUDE.md` states the reasoning — *"an operator
problem"*. Provisioning runs on every `bun install`, which is step 1 of
`./equin build`, so a backend that is serving has already been through it.

## Approach

### 1. The installer moves out of `core/`, into `provision/`

Delete `core/internal/ensure-chromium.ts` and drop `ensureChromium` from
`browser-fetch/core/index.ts`. The implementation moves into
`plugins/infra/plugins/safe-fetch/plugins/browser-fetch/provision/index.ts`,
renamed `provisionChromium()` — it reads as what it is at the folder it now
lives in — kept alongside the file's existing `export default provision`:

```ts
export async function provisionChromium(): Promise<void> { … }   // named: e2e-harness calls this
export default async function provision(): Promise<void> { await provisionChromium(); }
```

Keep the body **in `provision/index.ts` itself**, not a nested
`provision/internal/`: `tsconfig.tools.json` includes `plugins/**/provision/*.ts`
only, so a nested file would sit outside every TS program and go unchecked.
(Widening that glob is a fine follow-up; it is not needed for ~25 lines.)

Side effect worth keeping: with that file gone, `browser-fetch/core` reaches
neither `node:fs` nor `node:child_process` — it is pure again (`detectBotMitigation`
plus types). Update the barrel's header comment accordingly.

### 2. The download gets a ceiling and stops blocking

Replace `execFileSync` with `spawnPassthrough` from
`@plugins/infra/plugins/spawn/core` — the sanctioned chokepoint, which inherits
stdio (the download's progress output survives) and returns an exit code.
It carries no timeout of its own, so bound it by hand through its `onSpawn`
kill handle, at 15 minutes:

```ts
const INSTALL_TIMEOUT_MS = 15 * 60_000;
```

Fail loud on non-zero exit or on the timeout — the provision runner aggregates
failures and aborts the install, which is the behaviour `execFileSync`'s throw
already had. The bound matters even at install time: `./equin` runs
`bun install` on every invocation, so a hung download hangs a **build**, with no
human at the terminal watching a stalled progress bar.

Keep the `existsSync(chromium.executablePath())` fast path — it is what makes
the second contribution a noop, and it respects `PLAYWRIGHT_BROWSERS_PATH`
(which the verification below leans on).

### 3. `provision` becomes a declared runtime, so the boundary check enforces this

In `plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts`,
add to `runtimes`:

```ts
// Install-time provisioning steps (postinstall). They may read `core` and each
// other's `provision` barrels; NOTHING may read them. A provisioning step
// downloads and installs — work no request path may ever start.
provision: ["provision", "core"],
```

This does two things at once:

- **`server` / `web` / `core` → `provision` is now a check error.** The runtime
  map is default-deny and `provision` is on none of their allow-lists, so the
  class of mistake is caught, not just this instance of it.
- **`@plugins/…/browser-fetch/provision` becomes a legal cross-plugin barrel.**
  `runtimeNames` derives from these keys, and `plugin-boundaries` R4 reads it —
  which is what lets `e2e-harness/provision/index.ts` import `provisionChromium`
  from the one implementation instead of growing a second copy of the spawn.

It also closes a hole that exists today: `checkRuntime` returns `true` when the
source runtime is `null` (`boundaries/core/evaluate.ts:24`), and `provision/`
resolves to `null` — so a provisioning step could import `@plugins/x/web` right
now and nothing would say a word.

**Blast radius, verified.** Every other runtime enumeration in the repo is
independently hardcoded (`plugin-tree.ts:352`, `no-reexport-default`,
`pre-barrel-manifests-complete`, `plugin-boundaries` R3's
`["web","server","central","core"]`), so barrel-purity and barrel-required do
**not** start applying to `provision/index.ts`. `standardPluginDirs` already
knows `provision` via the collected-dir registry. The only other consumer is
R6's DAG edge tagging, where a `provision`-tagged edge falls outside all three
cycle graphs — acceptable, and worth one line of comment at the config.

All three existing contributions satisfy the new row as written: browser-fetch
(`spawn/core`), e2e-harness (`browser-fetch/provision`), zero/cache-service
(`zero/core` plus relative `../scripts/…`, which the check does not resolve).

### 4. The runtime path fails instead of installing

In `render.ts`: drop the import and the `await ensureChromium()`. Nothing
replaces it. `chromium.launch()` already throws immediately when the binary is
missing, and the existing `catch` already classifies that as
`browser-unavailable` — the card shows a failed thumbnail, nothing is cached,
and the fingerprint guard stops it retrying on every unrelated save.

Extend that message to name the remedy explicitly, matching
`browser-fetch/server/internal/errors.ts:browserUnavailable`:

```
could not launch chromium — run `bunx playwright install chromium` to provision it: <cause>
```

Removing the call also deletes the unbounded `await import("playwright")` that
was shadowing `loadPlaywright()`'s 30 s bound, so every `await` on the render
path is bounded again — which is what that file already claims about itself.

### 5. Docs

- `browser-fetch/CLAUDE.md` — the bounds table already says a missing chromium
  is `browser-unavailable`; add that provisioning is install-time-only and lives
  in `provision/`.
- `thumbnails/CLAUDE.md:59` — currently says *"`ensureChromium()` comes from
  `browser-fetch/core`"*. Replace with: chromium is provisioned at install time;
  a render never installs, it fails `browser-unavailable`.
- `docs/plugins-*.md` regenerate from `./equin build` (the
  `ensureChromium` entry under browser-fetch's core exports disappears).

## Files

| File | Change |
| --- | --- |
| `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/core/internal/ensure-chromium.ts` | deleted |
| `…/browser-fetch/core/index.ts` | drop the export; core is pure again |
| `…/browser-fetch/provision/index.ts` | new home of `provisionChromium()`, bounded `spawnPassthrough` |
| `plugins/framework/plugins/tooling/plugins/e2e-harness/provision/index.ts` | import from `…/browser-fetch/provision` |
| `plugins/apps/plugins/prototypes/plugins/thumbnails/server/internal/render.ts` | drop the call; remedy in the `browser-unavailable` message |
| `plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts` | `provision: ["provision", "core"]` |
| `…/browser-fetch/CLAUDE.md`, `…/thumbnails/CLAUDE.md` | prose |

## Verification

1. **Steady state is still a noop.** `bun plugins/framework/plugins/tooling/plugins/provision/scripts/run-provisions.ts`
   — all three contributions run and return instantly (this is the command that
   already proved the `@plugins` alias resolves inside a provision contribution).
2. **The download path actually works, without touching the real cache.**
   `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-scratch bun …/run-provisions.ts` — the
   `existsSync` misses, chromium downloads into the scratch dir with live
   progress, and the step exits 0. Delete the dir afterwards.
3. **The failure the runtime path now shows.**
   `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-empty bun -e 'const {chromium} = await import("playwright"); await chromium.launch()'`
   — confirm the thrown text is legible as the cause `render.ts` wraps.
4. **Boundaries.** `./equin check` (runs `boundary-rules`,
   `plugin-boundaries`, `type-check`, `plugins-doc-in-sync`). Then confirm the
   new rule bites: temporarily add
   `import { provisionChromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/provision"`
   to a `server/` file and check that `boundary-rules` fails on
   `server -> provision`; revert.
5. **End to end.** `./equin build` (background, per the workflow), then
   open `http://<worktree>.localhost:9000` → Prototypes and confirm a card still
   renders its thumbnail — the render path is unchanged apart from the deleted
   first line.
