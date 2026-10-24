# A repo script runs against whichever checkout's dependencies it happens to find

**Date:** 2026-08-25
**Category:** global (`cli`, `tooling/guards`, `tooling/e2e-harness`, `infra/safe-fetch/browser-fetch`, `bunfig.toml`, docs)

## Context

Every `e2e/` script was reported failing at launch:

```
error: launch: Executable doesn't exist at
~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

Revision 1234 belongs to Playwright **1.62.1**. The lockfile pins **1.60.0**
(revision 1223), which is present. So something ran a Playwright the repo never
chose.

> **Correction, recorded deliberately.** The first pass of this document blamed
> Bun's auto-install firing in worktrees without `node_modules`, and claimed 42 of
> 101 worktrees were broken. That was measured from a probe *outside* the repo tree
> and is **wrong**. Module resolution walks *up* the directory tree, and worktrees
> live under the main checkout — so a worktree with no `node_modules` resolves
> `playwright` from `/Users/epot/__A__/dev/singularity/node_modules`, gets 1.60.0,
> and launches revision 1223 fine. Verified in this worktree. Walk-up beats
> auto-install; also verified.

### What is actually true (all verified on this machine)

1. **Auto-install ignores every pinning mechanism** — not the caret range, not an
   exact version, not `bun.lock`. It resolves the bare specifier to registry `latest`:

   ```
   declared 1.59.1 -> resolved: 1.62.1
   declared 1.61.0 -> resolved: 1.62.1
   declared 1.62.0 -> resolved: 1.62.1
   ```

   It fires **only** when no ancestor directory has a `node_modules` at all. If one
   exists but lacks the package, you get a loud `Cannot find module` instead.

2. **A worktree without `node_modules` runs the MAIN CHECKOUT's dependency tree.**
   42 of 101 worktrees are in that state right now. Their scripts resolve against
   whatever main has installed — not against their own branch's `package.json` and
   `bun.lock`.

3. **`[install] auto = "disable"` does not change (2).** Verified: a child with
   `auto = "disable"` and no `node_modules`, under a parent that has one, still
   resolves the parent's playwright. It disables auto-*install*, not walk-up.

4. **Only auto-install can produce revision 1234 here.** No `node_modules` in any
   ancestor of the repo, and none inside it, holds playwright 1.61 or 1.62 —
   scanned. So the reported failure requires main's `node_modules` to have been
   absent or mid-replacement at that instant. Main's was last rewritten
   2026-08-25 03:48, and main auto-builds on every push, so that window recurs.

**Not established, and not guessed at:** which of those conditions held for the
reporting agent. The failure is not reproducible on demand.

**The actual defect** is (2), and it is worth stating without the Playwright
specifics: *a repo script resolves its dependencies from whichever checkout's
installed tree it happens to find first.* Which version you get depends on timing
— main's if it is there, registry-latest if it is not. A branch that bumps a
dependency does not get its own bump. Playwright is simply the one dependency
whose mismatch is *visible*, because it carries an out-of-band binary; a
`drizzle-orm` two minors off would just behave subtly differently.

**Intended outcome.** A script runs against its own branch's dependencies, or it
is stopped before it runs.

### Why three chromium versions are installed

Each Playwright minor pins its own chromium revision, and `playwright install`
only ever *adds*. It does garbage-collect — `_validateInstallationCache` →
`_deleteStaleBrowsers` deletes any browser directory no live installation claims,
where "live" means a registered link under `~/Library/Caches/ms-playwright/.links/`.
Six links are registered; three keep dead revisions alive:

| revision | Playwright | kept alive by |
|---|---|---|
| 1217 | 1.59.1 | a stale `node_modules/.bun/playwright-core@1.59.1/` dir left in the main checkout |
| **1223** | **1.60.0** | the real installs — the lockfile pin, the one in use |
| 1228 | 1.61.0 | `~/.npm/_npx/48b1ca104c3549f4/…` — an `npx playwright …` that fetched registry-latest |

~1.05 GB of the 1.6 GB cache is orphaned. Nothing needs deleting by hand: remove
the two stray *references* and Playwright's GC reclaims the rest on the next
install. This is why the `bunx`/`npx` remediation strings (§6) are a cause, not a
cosmetic issue.

### Why two paths for chrome

Two different binaries, installed as a pair by one `playwright install chromium`:

- `chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/…` — the headed
  browser, and what `chromium.executablePath()` returns.
- `chromium_headless_shell-<rev>/…/chrome-headless-shell` — the slim build
  Playwright launches for `headless: true` (since 1.49).

All four launch sites run headless — `e2e-harness/e2e/browser.ts:59` explicitly,
and `browser-fetch.ts:217`, `thumbnails/render.ts:174`,
`layout-harness/web/internal/measure-page.ts:115` by omission. So
`provisionChromium`'s guard, `existsSync(chromium.executablePath())`, stats the
**headed** binary while every caller launches the **shell**. They ship as a pair,
so it holds today; it does not check the thing it guards.

## Approach

### 1. `./equin run <script.ts> [args…]` — the correct spelling

The rule:

> Never `bun <file>`. Always `./equin run <file>`.

`bin/index.ts` runs `ensureDeps()` before dispatch for every verb, from a static
import closure that reaches no npm package. So `run` inherits the one thing
missing today: **this worktree's own `node_modules`, installed from this branch's
lock**, plus postinstall provisioning of the matching chromium. Roughly 140 ms
when the deps stamp is already fresh.

Deliberately **one general verb, not `./equin e2e`.** The problem is not
e2e-specific: of the 8 documented bare-`bun` invocations, two are not e2e
(`stats/cost/scripts/verify-vs-ccusage.ts` → `ccusage/data-loader`;
`browser-fetch/scripts/verify.ts`), and 14 more runnable scripts live under
`plugins/**/scripts/` — `server-core/scripts/backfill-pushes.ts` reaches
`drizzle-orm` and `pg` to write to the database. An e2e script is just a script,
and the harness already owns its target URL and reporting.

New plugin `plugins/framework/plugins/cli/plugins/run/`, mirroring
`plugins/framework/plugins/cli/plugins/format/`:

- `cli/index.ts` — `defineCliCommand({ name: "run", … })`, a `<script>` argument
  plus passthrough args. Must stay package-free (`cli:command-declarations-light`).
- `cli/run.ts` — resolve the path, fail naming it if it is not an existing
  module inside the repo, then `spawnPassthrough([process.execPath, script, ...args])`
  via `@plugins/infra/plugins/spawn/core` and forward the exit code. Follow
  `plugins/framework/plugins/cli/plugins/test/cli/run.ts`'s shape.
- `package.json` + `CLAUDE.md`.

**Accepted extensions must equal the guard's** (§2): `/\.(?:[cm]?[jt]sx?)$/` — ts,
tsx, mts, cts, js, jsx, mjs, cjs. Not `.ts` alone, as an earlier draft said. The
guard denies `bun x.mjs` and hints at `./equin run x.mjs`; if `run` refused
it, the hint would be a dead end. The resolution defect is identical for every
one of those extensions.

Then `./equin build` regenerates `cli.generated.ts`.

**Docs to update** — every bare `bun <path>` an *agent* is told to type:

- `CLAUDE.md` — "Driving the app", 2 spots. The `bun run playwright screenshot`
  line stays: it resolves a bin, not a module.
- `plugins/release/CLAUDE.md` (×3), `plugins/stats/plugins/cost/CLAUDE.md`,
  `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/CLAUDE.md`,
  `plugins/primitives/plugins/text-editor/plugins/caret-trigger/CLAUDE.md`,
  `plugins/debug/plugins/render-profiler/CLAUDE.md`,
  `plugins/infra/plugins/paths/CLAUDE.md` (inline prose, not a fenced block),
  `.claude/skills/debug/SKILL.md`
- the usage comments in `e2e-harness/e2e/screenshot.ts` and `e2e/perf.ts`, and in
  `sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs` — that one
  imports `chromium` from playwright, so it is a live instance of this very bug
- a rule in root `CLAUDE.md` stating both halves (agent-invoked vs machine-invoked)

**Leave alone**: `gateway/CLAUDE.md`, `plugins/framework/plugins/central-core/CLAUDE.md`
and `plugins/framework/plugins/cli/plugins/release/CLAUDE.md` all show
`bun bin/index.ts` describing how the *gateway* launches a backend — the
machine-invoked exception, correct as it stands. And all of `research/**`.

**The exception, which must be written down.** Scripts the *system* launches must
stay bare-`bun`-invocable: `provision/scripts/run-provisions.ts` executes inside
`bun install`, so routing it through `run` would recurse into `ensureDeps`; the
gateway launches `database/plugins/embedded/scripts/start.ts`; Claude Code
launches `guards/bin/guard.ts` from a PreToolUse hook, long before anything is
built. They work because they are npm-free by construction — verified in this
uninstalled worktree, where `guard.ts` and `flock-wait.ts` both resolve their full
import graph with no `node_modules`. So:

- **agent-invoked scripts** → `./equin run`; dependencies guaranteed
- **machine-invoked scripts** → stay npm-free, run bare

### 2. The `bun-script` guard — what makes the rule hold

Without this, §1 is a convention and nothing more: bare `bun script.ts` keeps
working (Context (3)), so it keeps silently using another checkout's tree. Rung 5
is not good enough when rung 3 fits.

The repo already enforces exactly this class of rule this way — `CLAUDE.md` says
"avoid `find`, use `rg --files`", and `core/guards/find.ts` is the PreToolUse guard
behind it. The new guard is the same shape.

`plugins/framework/plugins/tooling/plugins/guards/core/guards/bun-script.ts`:

```ts
export const bunScriptGuard = defineGuard<BashInput>({
  name: "bun-script",
  matcher: "Bash",
  bypassToken: ".allow-bun-script",
  check(input) {
    // Walk past flags and an optional `run`, then ask ONE question of the first
    // operand: does it carry a module extension, /\.(?:[cm]?[jt]sx?)$/ ?
    //
    // The discriminator is the extension, NEVER the presence of `run`. That
    // removes the need for both a subcommand denylist and a package.json
    // script-name allowlist (the latter impossible without reading
    // package.json): `install`/`test`/`add`/`build`/`x`/`pm` allow for free
    // because none is spelled as a module path, and `bun run playwright
    // screenshot …` allows because `playwright` carries no extension.
    …
    return {
      blocked: "`bun <file>.ts` resolves dependencies by walking UP the directory tree.",
      why: "A worktree without its own node_modules silently uses the MAIN checkout's installed tree — or, if that is mid-install, whatever npm's `latest` is today. Which version you get depends on timing, not on this branch's bun.lock.",
      hint: "Use `./equin run <file>.ts [args…]` — it installs this worktree's own dependencies from its own lock first, then runs the script.",
    };
  },
});
```

Register it in `core/registry.ts` under the `// Bash` group (hand-maintained list,
no codegen). Add `bun-script.test.ts` alongside, covering: bare `bun x.ts` blocked;
`bun run x.ts` blocked; `bun run playwright screenshot …` allowed; `bun install` /
`bun test` / `bunx …` untouched; a `bun` call inside a pipeline or `&&` chain still
matched (`findCall` walks the parsed call list).

Give it a `bypassToken` (`defineGuard` supports one) so an agent debugging a
machine-invoked script can be unblocked by the user rather than by working around
the guard.

Note this reaches agents, not humans at a terminal — which is right, since agents
are the actor this rule is for and `CLAUDE.md` is their contract.

### 3. Disable Bun's auto-install — a narrow backstop

Add to `bunfig.toml`:

```toml
# Bun's auto-install (the `--install=auto` default) fires when NO ancestor
# directory has a `node_modules`, and resolves the bare specifier to registry
# `latest` — it reads neither the package.json range (not even an exact version)
# nor `bun.lock`. That is how a script came to run playwright 1.62.1 while the lock
# said 1.60.0, demanding a chromium revision nothing had provisioned.
#
# NARROW ON PURPOSE: this does not stop resolution walking UP to another
# checkout's node_modules — that is what `./equin run` and the `bun-script`
# guard are for. It only removes the registry-latest arm when nothing is found at
# all, turning a silent wrong version into `Cannot find package 'x'`.
[install]
auto = "disable"
```

Stated as the backstop it is, not as a fix. Machine-launched scripts are npm-free
and unaffected.

### 4. Move to the current Playwright

Bump `playwright` `^1.60.0` → `^1.62.1` (chromium revision 1234) in:

- `package.json:55`
- `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/package.json`
- `plugins/apps/plugins/prototypes/plugins/thumbnails/package.json`

Keep the caret — `bun.lock` is the pin, and exact-pinning buys nothing against
auto-install, which ignores it (Context (1)). `./equin build` refreshes the
lock; postinstall provisions 1234.

### 5. Make the launch failure legible

`withBrowser` (`e2e-harness/e2e/browser.ts:59`) is the single choke point — 125
per-plugin scripts import the harness barrel and all browser lifecycle goes
through it. Wrap the launch and rethrow naming the resolved `playwright-core`
version, **the path the module resolved from** (the one line that would have made
this diagnosis immediate instead of a dozen probes), the expected executable, and
the fix.

Catch the launch rather than pre-stat a path: Playwright is the only authority on
which binaries a launch needs, and §"Why two paths" is what pre-stat'ing gets
wrong. Mirror `browser-fetch`'s `browserUnavailable` (`server/internal/errors.ts:49`).

### 6. One remediation spelling, enforced

`bunx`/`npx playwright` resolves independently of the workspace and falls back to
registry-latest — that is what created the `~/.npm/_npx/…@1.61.0` link pinning
orphan revision 1228. Rewrite all nine sites to `bun run playwright …`, the form
`plugins/primitives/plugins/css/plugins/layout-harness/check/index.ts:206` already
uses:

- `browser-fetch/server/internal/errors.ts:49`, `browser-fetch.ts:72`, `errors.test.ts:46`
- `thumbnails/server/internal/render.ts:191`, `thumbnails/CLAUDE.md:67`
- `browser-fetch/CLAUDE.md:90`
- `browser-fetch/provision/index.ts` — the two message strings **and the spawned argv**

Add the enforcing check at
`plugins/framework/plugins/tooling/plugins/e2e-harness/check/index.ts` (id
`e2e-harness:pinned-playwright-invocation`), failing on `bunx playwright` /
`npx playwright` anywhere in the tree. `plugins/<name>/check/index.ts` is
discovered at runtime — no registry edit. Scope it out of `research/**`, a
historical record that must not be rewritten.

### 7. Fix the provisioning guard

In `browser-fetch/provision/index.ts`, replace
`if (existsSync(chromium.executablePath())) return;` with an unconditional pinned
install. Three reasons in order of weight: it checks what is actually launched
(the shell, not the headed binary); Playwright owns the completeness question, so
we stop re-deriving it; and running the installer triggers the
`_deleteStaleBrowsers` GC, so the cache prunes itself instead of growing forever.

Spell it pinned by resolving through the *same module graph* as the
`await import("playwright")` above it — e.g. `Bun.resolveSync("playwright/cli.js", root)`
spawned with `process.execPath` — so installer and launcher cannot disagree by
construction. Keep the existing `spawnPassthrough` + 15-minute `INSTALL_TIMEOUT_MS`
bound and its `onSpawn` kill handle.

**Measured, and the answer changed the design.** An already-satisfied
`playwright install chromium` costs **~3.0 s** of subprocess — well above the
~0.5 s guessed here, and it would be paid on every install that changes *any*
dependency. So the stamp fallback is in, at `node_modules/.singularity-chromium`,
keyed on `(playwright-core version, PLAYWRIGHT_BROWSERS_PATH)`.

The distinction that makes the stamp legitimate rather than a return of the guard
it replaces: **the stamp records a verdict Playwright itself returned**, whereas
`existsSync(executablePath())` invented its own answer to "is the browser
complete?" — and answered about the wrong file. Nothing is re-derived.

Stated plainly, what the stamp cannot see: a browser cache deleted by hand while
`node_modules` stays put. That is survivable only because the resulting failure is
loud and self-remediating (§5 and `errors.ts:browserUnavailable` both name the
exact command), and reclaiming the cache is a deliberate operator act. The stamp
lives INSIDE `node_modules` for the same reason as the CLI's `.singularity-deps`:
it can never outlive the dependency tree it describes.

### 8. Reclaim the ~1.05 GB

Delete the two stray *references*, then one install; Playwright's GC does the rest:

```sh
rm -rf ~/.npm/_npx/48b1ca104c3549f4                                                # frees 1228
rm -rf /Users/epot/__A__/dev/singularity/node_modules/.bun/playwright-core@1.59.1  # frees 1217
bun run playwright install chromium                                                # installs 1234, GCs the rest
```

Revision 1223 lingers while worktrees still hold a 1.60.0 `node_modules` — correct,
they would break otherwise. It clears as those are reinstalled or reclaimed.

### 9. Follow-ups (not in this change)

- Extend `cli:bootstrap-package-free` to the machine-invoked script set, so their
  npm-freedom is enforced rather than incidental.
- A check that no doc shows a bare `bun <path>.ts` command line.

### Rejected: give every worktree its own `node_modules`

This would make bare `bun` *correct* rather than forbidden. Measured: the 59
worktrees that have one already use **44 GB**, so covering all 101 adds roughly
31 GB. And it still would not be correct — a worktree installed last week whose
branch has since changed dependencies is stale, and nothing would notice.
Expensive and still wrong.

## Verification

1. `./equin build` — regenerates `bun.lock` and `cli.generated.ts`, and
   provisions revision 1234 via postinstall. Confirm the install appears in the log.
2. `ls ~/Library/Caches/ms-playwright` — `chromium-1234` and
   `chromium_headless_shell-1234` present; 1217 and 1228 gone after §8.
3. **The guard**: ask an agent session to run `bun plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts`
   — the call must be blocked with the hint naming `./equin run`.
   `bun run playwright screenshot …`, `bun install` and `./equin test` must
   all still pass through untouched.
4. **The defect itself**, in a worktree with no `node_modules`:
   `bun -e 'console.log(Bun.resolveSync("playwright", process.cwd()))'` currently
   prints a path under the MAIN checkout. After `./equin run` has been used
   there once, it must print a path inside the worktree.
5. `./equin run plugins/apps-core/plugins/tabs/e2e/tabs-verify.ts` passes
   from a worktree that has never been built; `--headed` forwards through.
6. `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --url http://<worktree>.localhost:9000 --out /tmp/shot`
   writes the images.
7. `./equin run plugins/does/not/exist.ts` fails naming the path, not with a
   Bun module error.
8. Machine-invoked scripts still work bare, with no `node_modules`:
   `bun build --no-install --target=bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts`
   resolves (it does today — this is a regression guard).
9. §5's message: point `PLAYWRIGHT_BROWSERS_PATH` at an empty dir and confirm the
   error names the version, the resolved-from path, the expected executable, and
   the fix.
10. `./equin check` — clean, including `e2e-harness:pinned-playwright-invocation`;
    confirm it fails when `bunx playwright` is reintroduced and does not flag `research/`.
11. `./equin test plugins/framework/plugins/tooling/plugins/guards` — the new
    `bun-script.test.ts` passes; and
    `./equin test plugins/infra/plugins/safe-fetch/plugins/browser-fetch` —
    `errors.test.ts:46` tracks the new string.
12. Backend launch paths still work: open a prototype thumbnail and refresh a
    `browser-fetch`-backed events source.
