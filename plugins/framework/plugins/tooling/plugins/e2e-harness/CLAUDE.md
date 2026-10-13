# e2e-harness

## The target URL, and who chose the path

One flag, `--url` (`--base` / `--origin` are aliases), carrying one URL that
`target.ts` splits: the origin says which deploy, the path says which screen.
No script can obtain the bare origin — there are only two spellings, and the
difference is *who chose the path*:

- `pathUrl("/pages")` — the page THIS SCRIPT drives. Nearly every script. The
  root is `pathUrl("/")`.
- `pageUrl("/agents")` — the page THE CALLER named, falling back to that
  default. Only for tools whose job is "open the page I name": `screenshot.ts`,
  `perf.ts`, `render-profile.ts`, `live-state-churn.ts`, `adaptive-bar-*`.

So pass a page to a script that drives its own and the run FAILS at teardown,
naming the path you gave — it would otherwise pass, having tested a screen you
did not ask for. And a helper never takes a `base` parameter: `openBlankPage`
and `support/runs.ts` resolve their own target.

## The default target is READ from the registry, never guessed from a name

Pass no target flag and the script drives the deploy **this checkout
published** — `resolveCheckoutDeploy(REPO_ROOT)` reads every
`~/.singularity/worktrees/<ns>/spec.json` and keeps the namespaces whose
`server` path is this checkout's backend. Nothing is derived from a directory
name, and no environment variable has any spelling in this runtime.

That is not fastidiousness. The default used to be
`$SINGULARITY_WORKTREE ?? basename(REPO_ROOT)`, and that variable answered a
question about a different process: the gateway set it on the backends it
spawned, an agent pane inherited it through the tmux server, so from inside any
worktree it said `singularity`. (The variable itself is gone now — see
`infra/runtime-identity` — but the lesson about environment-derived targets is
what this rule keeps.) Argument-less runs drove MAIN's app
and printed `ALL CHECKS PASSED` — and, since `withBrowser` opens by POSTing the
config repair to the resolved origin, reverted the user's live config documents
there before doing anything else. A name is only ever a guess about what
somebody else registered; the registry is the record the build itself wrote.

So the answers a name could not give are the ones you now get, each as a
`usage()` refusal (exit 2, before chromium launches and before the first
request):

- **This checkout has never been built** → `registered : (none)`, and run
  `./singularity build`. A basename would have handed back a live, plausible,
  entirely unrelated host.
- **This checkout published only a composition** → the refusal LISTS what is
  registered and points at `--composition sonata`. A composition build
  publishes `sonata.att-x`, whose namespace shares no label with the checkout,
  so no basename could have named it even in principle.
- **`--composition x` names one this checkout did not publish** → same shape,
  listing the ones it did.

`--composition <id>` is the only way to name a composition deploy. Passing it
alongside `--url` / `--base` / `--origin` is a usage error rather than a silent
drop: both flags answer "which deploy", so honouring one would run against the
deploy you explicitly did not name.

Every run prints the deploy it resolved, from inside `target()`'s one memoized
resolution rather than from a call site — 134 of the 165 scripts never bind
`pathUrl` at module top level and so printed nothing identifying their target,
which is why a fleet of green runs against main left no trace in any transcript:

```
target: http://att-….localhost:9000  (this checkout's singularity deploy, build-…-kb3y1y, built 4m ago)
```

`targetNamespace()` is for a script that must read or assert on a per-namespace
file on disk — a config document, a log, an artifact. It hands back an
IDENTITY, not a way back to an origin: rebuilding a URL from it with
`namespaceUrl` would ignore `--url` and point the script at the gateway
instead. Use `pathUrl` for anything the app answers.

`e2e-harness:target-not-env-derived` keeps the class out — any
`process.env.SINGULARITY_*` under `*/e2e/*.ts` fails the check. The prefix, not
the one variable: `$SINGULARITY_E2E_BASE` had the same shape (an inherited
channel that silently outranks the derivation, which nothing in the repo ever
set) and was deleted with it, so a second env-shaped target has to be
unspellable rather than merely absent today.

## A script that goes green without exercising the app is worse than no script

It gets cited as evidence. Three mechanisms here exist only to make that outcome
hard to reach.

**`report()` fails the run on unhandled rejections.** `finish()` ends with an
explicit `process.exit(0)`, which overrides the exit code the runtime would have
set on its own — so anything that threw outside the script's own `await` chain (a
route handler, a listener, a detached promise in a helper) used to print to stderr
and still be followed by `ALL CHECKS PASSED`. Those are now FAIL lines.
`uncaughtException` is deliberately NOT intercepted: a listener there would keep
the process alive past a fatal error, and an uncaught throw already fails loudly.
Limit: a rejection raised after the script's last `await` can still land after
`finish()` has exited.

**`stallRoute()` is the only sanctioned way to hold a request.** Optimistic-render
scripts stall a write endpoint and assert the UI updated well inside the stall —
latency alone is a weak assertion, since a localhost round-trip can beat a slow
poll. The hand-rolled version of that (route, sleep, then `unroute` when done) is
silently broken: `unroute` does not wait for a running handler, so removing the
last one continues the paused request immediately — the stall ends early, and the
sleeping handler's `route.continue()` throws `Route is already handled!`. The
primitive ends its stall on a signal instead of a teardown; the `no-unroute` lint
rule keeps the broken shape from coming back.

**`assertDeployIdentity()` proves the app answering the target is the build this
checkout made.** Resolving the right namespace is not the same as reaching the
right build: point at a deploy nobody rebuilt and every assertion below is made
against code this checkout did not produce. Two independently written records
settle it — `build-status.json`, written at the namespace directory's root by
the build that took the lock, and `.build-id`, written INSIDE the dist that
build published and served over HTTP by the gateway. Reading the local dist
instead would be a tautology, since `spec.web` is that same directory. The
compare is exact and the token must be whitespace-free, because the gateway
answers an unknown path with the SPA at HTTP 200, so `res.ok` is not evidence of
a hit.

`withBrowser` awaits it as its FIRST statement, above the config repair, so a
refusal lands before the first request rather than before the first assertion;
`agentFetch` awaits it too, which covers the scripts that never open a browser.
A `--url` skips it entirely — that arm carries no build of ours to compare
against, by construction — and only an `ok` receipt can refuse. `running`,
`interrupted`, `failed`, `superseded` and "no receipt" warn on stderr and
proceed: main auto-builds on every `refs/heads/main` advance and an interrupted
build is routine, so refusing on those would block every script in a checkout
over a dist that is almost certainly still the previous, complete, correct one.

Limit: it proves the served DIST, not the backend. A `--no-restart` build
writes an `ok` receipt with a new dist and leaves the previous backend running,
so a run can still be green against a new frontend talking to old server code.
Nothing here can see that — the receipt records one build id for both halves.

## A run puts the user's data back

A DataView writes its per-instance sort / filter / groupBy straight back through
config_v2 into the user's DURABLE config layer, and a prototype's option picker
writes the shared picks record. So a script that clicks "Group by Kind" to
verify grouping leaves the surface grouped for the user — and poisons its own
next run's baseline (a "0 expanded elements" baseline became 44; the assertion
saw 44 → 44 and failed, looking exactly like a product bug).

`withBrowser` now reverts that automatically, so **do not hand-write a teardown
that puts a control back**. The server records the pre-write bytes of
everything a request carrying the agent-origin header overwrites — one ledger
per domain, all through the shared
[`agent-write-ledger`](../../../../../infra/plugins/request-origin/plugins/agent-write-ledger/CLAUDE.md)
primitive — and the harness restores them (`settleAgentWrites` /
`repairAgentWrites` in `e2e/agent-writes.ts`, which name no domain; each line
they print reads `<ledger label>: <key>`):

- **at the START of every run**, before chromium launches — repairing a previous
  run killed by Ctrl-C, SIGKILL or a Playwright timeout, which is the half no
  teardown can provide;
- **at the END**, after `browser.close()` and after draining in-flight writes.
  That order is load-bearing: the write-back is a 400 ms trailing debounce living
  in a `setTimeout` inside the page, so closing first bounds what can still
  arrive.

Not covered, by construction: **secret (provider-backed) config fields**, which
never touch the JSONC layer; and a script's own **Node-side `fetch`**, which the
browser context's headers cannot reach — use `agentFetch` for those
(`agent-origin-safety/no-unmarked-app-fetch` enforces it).

The provenance headers go on the app's requests **only**. Playwright's
`extraHTTPHeaders` is context-wide, and a custom header turns a cross-origin
fetch into a preflighted one that Google Fonts, unpkg and every other CDN
refuse — so a prototype's web font silently fell back to the system face in
every capture. `withBrowser` strips the two headers from any request leaving
the target origin (`keepOriginHeadersOnTarget`, gated on `isTargetOrigin`, a
predicate the harness keeps internal so no script gains an origin string).

**Do not run two e2e scripts concurrently.** Revert-all is what lets a run repair
one it did not launch; the price is that one script's end-revert would restore
another's in-flight writes. The same start-of-run repair means **config writes
belong INSIDE the `withBrowser` callback**: a write made before it opened reads
as one "left by a previous run" and is reverted before the page loads.

**Rows a script seeds** are not config, so nothing reverts them: `openDeployDb()`
(`e2e/deploy-db.ts`) opens a `pg.Pool` on the target deploy's database —
refusing main, whose database is the user's — and the script deletes what it
seeded itself (`onBeforeFinish`, with a run-unique id prefix and a sweep of a
killed run's leftovers first).

## Network idle is measured here, not by Playwright

Playwright's `networkidle` never fires on this app. The live sockets run in a
SharedWorker (networking's `SharedWebSocket`); Playwright reports the worker's
script load as a request of the page that started it, but the response lands in
the worker's target, which Playwright does not attach to — so that request never
finishes. `waitForNetworkIdle(page)` (`e2e/network-idle.ts`, and `boot()`
without a marker) counts the page's in-flight requests itself and leaves out a
worker-chunk load (`isWorkerChunkPath` from web-artifacts, the one place worker
scripts are emitted). Every page a session creates is tracked from its first
request; a page the harness never saw is refused. The `e2e-harness/no-networkidle`
lint rule rejects the literal in e2e scripts.

For the same reason, `page.on("websocket")` and `routeWebSocket` see nothing of
the live sockets: frame assertions and socket faults go through
`tapSharedSocket` (`@plugins/primitives/plugins/networking/e2e`).

## Chromium arrives on demand

No browser is installed at `bun install`. Chromium is the `chromium`
dependency (`safe-fetch/browser-fetch`'s `deps/`, kind `playwright-browser`),
and `withBrowser` gets it with `ensureDepViaCli(chromium, { stdio: "inherit" })`:
one `readyNow` when it is installed; otherwise a `./singularity deps install
chromium` child — its progress on this terminal, ~280 MB, once per machine per
`playwright-core` version — then the proof. The launch is
`launchChromium(ready, { headless: !--headed })`: the recorded
`chrome-headless-shell`, or with `--headed` the headed binary of the same
revision. A launch failure is re-thrown with the playwright that ran (and
where it resolved from), the install dir and the executables it recorded.

## `diffImages` — two captures in, a number and a picture out

`diffImages(page, aPng, bPng, { threshold, grid, labels })` compares two PNG
buffers and answers with the differing-pixel ratio, a row-major grid of
per-cell ratios (`heatmapText(grid)` prints it), a diff PNG (A in faint grey,
every differing pixel red) and a side-by-side sheet (A, B, diff under
captions — the one image to open). Size mismatch is reported (`sameSize`,
both sizes) and the top-left intersection is compared, never silently
cropped-and-passed.

The work happens INSIDE the page, on a canvas, the way `samplePixels` decodes
its band: Chromium already owns a PNG codec, so the harness carries no image
dependency and parses no format. The distance metric is pixelmatch's YIQ
formula under the same default threshold (0.1); its anti-aliasing detector is
deliberately not ported, since the callers here compare whole regions and the
grid averages edge halos away.

Meaningful only between captures from the SAME renderer at the SAME width —
a mock beside the app, a before beside an after. Against a design tool's
export, text rasterisation alone differs everywhere, and the number means
nothing. `prototypes/compare/e2e/compare-diff.ts` is the worked example.

## `colorReport` — the colours, named

The pixel diff is salient by construction: a surface one shade off passes its
threshold, and a wrong background comes back as "31% differs" with no colour
in the transcript. `colorReport(page, aPng, bPng, { deltaE, grid, paletteSize,
bands, labels })` answers the colour questions separately, in the same in-page
canvas pass:

- **palette** — each picture's dominant colours by coverage (5-bit quantised,
  near-duplicates folded, the bucket's MEAN reported), A's top entries each
  matched to B's nearest, with the CIE76 ΔE between them. The first pair is
  the background.
- **region means** — the mean colour of each grid cell in both pictures and
  its ΔE; averaging cancels glyph edges, so this sees a tint shift the pixel
  diff waves through without being fooled by anti-aliasing.
- **luminance profiles** — L* per row band and per column band, so a gradient
  one side painted flat, or a lighter overall tone, is a visible curve.

`colorReportText` prints it; `sheetPng` draws swatches, the two region
mosaics and the profile curves. ΔE ~2 is just noticeable, 5 is plainly a
different shade, 10+ a different colour.

## `finish()` is the teardown chokepoint, so `await` it

`report().finish()` ends in `process.exit()`, which skips `finally` — and most
scripts here call `finish()` INSIDE the `withBrowser` callback. So teardown
registers via `onBeforeFinish` and `finish()` drains it; that is why `finish()`
returns a promise and why `no-floating-promises` requires `await r.finish()`.
Before this, `await browser.close()` in `withBrowser`'s `finally` was silently
skipped for those scripts, leaking a Chromium process per run.

## `failedRequests` means "never got a response" — a 204 is not in it

`capture()`'s `failedRequests` lists requests that got no response at all: a
dial failure, an `AbortController`, a navigation or a close mid-flight. Assert
on it like the other two arrays. Chromium, as seen through Playwright, also
fires `requestfailed … net::ERR_ABORTED` for a successful fetch with an empty
body (a 204, or a 200 with no body), and every void endpoint answers 204. So
the listener goes through `requestFailure(req)`, which returns `null` when
`req.timing().responseStart >= 0` (a response did arrive). A script with its
own `requestfailed` listener calls it too. Diagnosis:
`research/2026-09-25-framework-e2e-empty-body-requestfailed.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Shared Playwright harness for the per-plugin e2e/ scripts: argv parsing, worktree-derived target URL, browser/session lifecycle, error capture, pass/fail reporting, screenshots, and Chromium on demand (the first run on a machine installs it through `./singularity deps install chromium`). Also owns the two generic tools (screenshot, perf).
- Core:
  - Uses: `framework/tooling/guards.MODULE_EXTENSION`
  - Exports (values): `isE2eScriptPath`
- Cross-plugin:
  - Imported by: 148 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×46
    - `primitives` ×24
    - `page` ×23
    - `conversations` ×16
    - `apps-core` ×5
    - `debug` ×5
    - `tasks` ×4
    - `active-data` ×3
    - `config_v2` ×3
    - `shell` ×3
    - `ui` ×3
    - `infra` ×2
    - `reorder` ×2
    - `build`
    - `database/admin`
    - `improve/element-picker`
    - `map/google`
    - `network/live`
    - `plugin-meta/exhibits`
    - `release`
    - `reports`
    - `runs`
- Exemptions:
  - Exempts itself from: `agent-origin-safety/no-unmarked-app-fetch` — `e2e/app-fetch.ts`, `e2e/deploy-identity.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
