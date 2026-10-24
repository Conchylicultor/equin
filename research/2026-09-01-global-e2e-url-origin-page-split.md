# e2e harness: split the deploy ORIGIN from the PAGE it opens

## Context

The command the repo's own `CLAUDE.md` tells every agent to run for ad-hoc UI
verification cannot run at all:

```bash
./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
  --url http://<worktree>.localhost:9000/deploy/server/<id>/dep/<id> --click "…"

SyntaxError: Failed to parse JSON
  at callEndpoint (e2e/agent-writes.ts:44)
  at repairAgentConfigWrites (e2e/agent-writes.ts:98)
  at withBrowser (e2e/browser.ts:175)
```

It fails before the browser even opens, inside the harness's own setup, with a
message that names neither flag.

### One URL, two components

A run has exactly ONE target URL. It has two components, and they go to two
different consumers:

```
--url http://wt.localhost:9000/deploy/server/3/dep/91
      └────── origin ────────┘└────── path ────────┘
      which deploy?            which screen?
              ↓                       ↓
      pathUrl("/api/…")          page.goto(…)
      builds every API call      opens the screen under test
```

The origin is not a second input — it is the target URL with the path cut off.
There is never a run where "the origin" and "the page's origin" differ, and
nobody ever passes both.

The bug is that `baseUrl()` in `e2e/target.ts` never performs that split. It
accepts `--url` as a plain alias for `--base` and hands **the whole string** to
the consumer that only wanted the origin half.

`screenshot.ts` reads that same unsplit `baseUrl()` result as the page — and its
usage block, `perf.ts`'s, and root `CLAUDE.md` line 188 all document `--url`
with a path. So a path-carrying `--url` becomes an "origin" with a path glued
inside it, and every API call in the run is built on top of that:

```
--url http://wt.localhost:9000/deploy/server/3/dep/91
      └────────── stored whole as the "origin" ──────────┘

pathUrl("/api/config-v2/agent-writes/revert")
→ http://wt.localhost:9000/deploy/server/3/dep/91/api/config-v2/agent-writes/revert
                                                  └── the SPA catch-all answers
                                                      this with index.html, 200 ──┘
→ res.ok is true → res.json() on HTML → "Failed to parse JSON"
```

A 200 with an HTML body is why the failure reads as a parse error rather than a
404.

This was latent until the agent-config-write revert ledger landed (3710ee071),
which made `withBrowser` itself call the app's API through `pathUrl()` on every
single run. Before that, only scripts that happened to call `pathUrl()` were
affected; now every script is, including the ad-hoc `screenshot.ts` drive.

The same collision is already hand-rolled in four other scripts
(`improve/element-picker/e2e/pick-contribution-slack.ts`, and the three
`primitives/adaptive-bar/e2e/adaptive-bar-*.ts`), which each read
`arg("url")` themselves as a page *while* `baseUrl()` swallows it as an origin —
so they are broken the same way for the same reason.

### Intended outcome

The documented invocation works. And the collision has no spelling left: a
script cannot hold an origin, so it cannot navigate to one or confuse one for a
page.

## Approach

`e2e/target.ts` becomes the one place the target URL is split, and the barrel
stops exporting the unsplit half.

### 1. One flag carries the URL; `target.ts` splits it

Since the origin is derivable from the page URL, there is no reason for two
flags that both take a URL — that overlap is what caused the bug. `--base` and
`--origin` stay as **aliases** of `--url` so no existing invocation breaks, but
they are one flag with one meaning: *the target*. `target.ts` parses it once
and serves each half to its own consumer.

| what is passed | origin (`pathUrl`) | page (`pageUrl`) |
| --- | --- | --- |
| `--url http://wt:9000` | `http://wt:9000` | the path the script names |
| `--url http://wt:9000/deploy/server/3` | `http://wt:9000` | `/deploy/server/3` |
| `$SINGULARITY_E2E_BASE` | same rules | same rules |
| nothing | this worktree's own deploy (unchanged) | the path the script names |

`--path` is unaffected and does not collide: it is a path, never a URL, so it
has no origin half to disagree about. It stays on the three `adaptive-bar`
scripts as "same deploy, this screen".

Only two things are errors, both via `usage()` from `e2e/args.ts` (one line,
exit 2, before chromium launches):

- A value `new URL()` cannot parse (`--url wt.localhost:9000`, no scheme). Today
  that silently yields a broken concatenation.
- `--url` carrying a path *and* `--path` — the same thing said twice, so which
  one wins is a coin flip. (See §3 for the other path-related failure.)

Dropped from the earlier draft, because one flag makes them unreachable:
"`--base` must not carry a path", "`--url` and `--base` disagree about the
origin", and any precedence rule between the two.

### 2. The barrel exports two page builders and no origin

```ts
// e2e/target.ts

/** The target, split once. Module-private: nothing outside this file sees it whole. */
function target(): { origin: string; path: string | undefined };

/** origin + a path THIS SCRIPT chose. The only way to reach the root: pathUrl("/"). */
export function pathUrl(path: string): string;

/** origin + the path THE USER chose (--url's path, or --path), else `fallbackPath`. */
export function pageUrl(fallbackPath?: string): string;
```

`pageUrl` is exactly the shape `adaptive-bar-overfull-row.ts:101` already
hand-rolls (`explicitUrl ?? pathUrl(path ?? "/agents")`), lifted into the
harness.

`index.ts` exports `pathUrl` and `pageUrl`. **`baseUrl` is removed from the
barrel** and becomes private to `target.ts`. That is the load-bearing half: with
no origin string in a script, `page.goto(<an origin>)` has no spelling, and
`` `${BASE}${path}` `` — which is where a missing or doubled slash lives — has
none either. A plugin that reimports `baseUrl` is a tsc error, not a convention.

`app-fetch.ts` keeps calling `pathUrl` and needs no change.

### 3. A `--url` no script consumed fails the run

Residual case after the above: `tabs-verify.ts --url http://wt:9000/pages` drives
`/agents` anyway, because that script names its own page. The origin is taken
correctly, so nothing crashes — it just silently tests the wrong screen.

`target.ts` records whether `pageUrl()` was ever called. `withBrowser` registers
a teardown (via the existing `onBeforeFinish` in `e2e/report.ts`) that throws
when `--url` carried a path and `pageUrl()` was never called:

```
--url named a page (/pages) but this script drives its own.
  Drop the path to point it at another deploy: --url http://wt.localhost:9000
```

Teardown, not startup: three scripts read their page inside the `withBrowser`
callback, so a startup assert would false-fire on correct scripts. `finish()`
records a throwing teardown as a `FAIL` and exits 1 (`report.ts:172`), and for
the tools that never call `report()` the throw propagates out of `withBrowser`'s
`finally` — loud on both paths.

### 4. Migrate the fleet

**The four generic driving tools** — the ones whose whole job is "open the page I
name" — switch to `pageUrl()`:

- `e2e-harness/e2e/screenshot.ts:33`
- `e2e-harness/e2e/perf.ts:50`
- `debug/render-profiler/e2e/render-profile.ts:55`
- `debug/live-state-churn/emit/e2e/live-state-churn.ts:70`

**The four hand-rolled sites** drop their own `arg("url")` and call
`pageUrl(<their default path>)`:

- `improve/element-picker/e2e/pick-contribution-slack.ts:26`
- `primitives/adaptive-bar/e2e/adaptive-bar-{overfull-row,churn,hidden-host}.ts`

**Every other `baseUrl()` call site** — 88 across 85 files, all of the same two
shapes — becomes `pathUrl()`:

```ts
// before
const BASE = baseUrl();
await page.goto(`${BASE}/agents`);
await page.goto(`${base}${deepPath}`);
await page.goto(BASE);

// after
await page.goto(pathUrl("/agents"));
await page.goto(pathUrl(deepPath));
await page.goto(pathUrl("/"));
```

Representative files (the rest are the same edit): `page/editor/e2e/*.ts` (~30,
the largest cluster), `apps-core/tabs/e2e/history-nav.ts` (6 sites, template
literals with a variable path), `primitives/networking/e2e/shared-websocket.ts`,
`primitives/css/control-panel/e2e/panel-inset-verify.ts:306` (`${baseUrl()}${path
|| "/agents/tasks"}` → `pathUrl(path || "/agents/tasks")`),
`ui/theme-toggle/e2e/theme-toggle-verify.ts`. The `const BASE = baseUrl()`
module-scope line and the now-unused `baseUrl` import go with it.

Nothing outside `e2e/` is touched — the other `baseUrl` hits in the repo
(`infra/asset-mirror/core/url.ts`, `apps/sonata/audio/piano/*`,
`database/zero/cache-service/scripts/*`) are unrelated locals.

### 5. Docs

- `screenshot.ts` / `perf.ts` / `render-profile.ts` usage blocks: `--url` takes a
  URL that may carry a page path; `--base` / `--origin` are aliases of it.
- The ~25 per-plugin scripts whose usage line reads `[--base http://<worktree>.localhost:9000]`
  need no wording change — that invocation keeps working — but their `--base`
  becomes `--url` in the same sweep as the code edit, so the fleet spells one flag.
- `e2e-harness/CLAUDE.md`: a short section carrying the "one URL, two components"
  diagram, so the next reader learns the split rather than the workaround.
- Root `CLAUDE.md` line 188 needs no change — making that exact command work is
  the point of the whole change.
- `docs/plugins-details.md` regenerates on `./equin build` (`baseUrl`
  leaves the harness's public exports).

## Verification

1. `./equin build` (background — it also regenerates the plugin docs).
2. The reported failure, on a real deployment page:
   ```bash
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/deploy/server/<id>/dep/<id> --out /tmp/dep
   ```
   Expect `/tmp/dep-before.png` showing the deployment pane — not a JSON parse
   error, and not the root screen. `<id>`s from `query_db` against
   `deploy_servers` / `deployments`.
3. A URL with no path still means "that deploy, the script's own screen":
   `screenshot.ts --url http://<worktree>.localhost:9000` → root screen, no error.
   Then the same with `--base` and with `--origin`, proving the aliases survived.
4. Both usage errors, one run apiece: `--url <wt>:9000` (no scheme) and
   `--url http://<wt>:9000/pages --path /agents`. Each must print one line naming
   the flag and exit 2 before chromium launches.
5. The unconsumed-`--url` guard:
   `./equin run plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts --url http://<wt>:9000/pages`
   → `FAILURES: 1/n`, exit 1.
6. Three migrated per-plugin scripts run green unchanged, one from each shape —
   e.g. `plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts`,
   `plugins/page/plugins/editor/e2e/copy-paste-verify.ts`,
   `plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-overfull-row.ts`.
   (One at a time — concurrent runs fight over the config revert.)
7. `./equin check` — `type-check` is what proves the barrel removal caught
   every call site.
