# Absorbable-failure guardrail: inventory + global prevention

## Context

Three independent bugs shared one shape: a producer signals failure with a
value consumers can absorb as ordinary data, and downstream layers
cache/publish it as settled truth — (1) pane route empty-for-three-realities
(fixed: tri-state route, `research/2026-07-08-global-tristate-pane-route.md`),
(2) untracked plugin-chunk load failure (fixed: `failedPluginPaths`), (3)
`runGit` null → `computeEditedFiles` `[]` → destructive "Drop & Close" over
real changes (filed: `task-1783518959947-muil14`). This plan delivers the
codebase-wide inventory of remaining instances ranked by blast radius, and
the structural guardrail that prevents the class globally. Proven rule of
thumb: **cure at the producer — make failure a type the consumer must
handle, not a value they can mistake for data.**

## Key finding: three archetypes, three different cures

- **A1 — fallible IO wrapper returns `value | absorbable`.** `runGit:
  string|null`, `readSha: string|null`, CLI `run` whose `exitCode` is
  discarded at the destructure. Cure at the producer: **throw by default**,
  named probe variant where nullable is the real semantics. Not lintable at
  consumers (nullable is legitimately everywhere).
- **A2 — `catch` returns an absorbable literal** (`return []`, `return 0`).
  Compiles clean, passes `no-bare-catch` (which only checks catch-body
  shape). Cure: **new syntactic lint rule**.
- **A3 — client raw `useQuery` reads `.data ?? []`, never `.isError`.** Only
  2 bypasses exist repo-wide (useEndpoint/useResource conventions already
  prevent new ones). Cure: fix inline, no new machinery.

## Inventory (ranked by blast radius)

| # | Instance | Decision the false-empty feeds | Fix |
|---|---|---|---|
| 1 | `runGit` null conflation — `plugins/primitives/plugins/commit-list/server/internal/run-git.ts:15` (`code === 0 ? out : null`); absorbed via `if (diff)` truthiness at ~20 sites; worst chain: `get-edited-files.ts` → `editedFiles` resource → **destructive "Drop & Close"** exit default | destructive action gate | WS1 (subsumes task-1783518959947-muil14) |
| 2 | CLI push dirty-check — `plugins/framework/plugins/cli/bin/commands/push.ts:350` destructures only `stdout` from `run(["git","status","--porcelain"])`; git failure ⇒ `""` ⇒ "clean tree" ⇒ **push proceeds over uncommitted changes**. Same at :191 (`postRebaseNormalize`) | merge-to-main gate | WS1 |
| 3 | Cache-signature poisoning — `commits-graph/server/internal/compute-graph.ts:88-90`, `review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts:33-36`: git-state memo keys built as `(await runGit(...))?.trim() ?? ""`; two *different* failures collide on `""` ⇒ stale cross-failure cache hit served as fresh | persisted server memo | WS1 |
| 4 | commits-graph false zeros — `compute-graph.ts:26-72`: failed merge-base → `ZERO_DELTA`, failed `rev-list --count` → `NaN→0`, both cached and pushed live (ahead/behind chip) | live resource + cache | WS1 |
| 5 | git-watcher `readSha` — `infra/plugins/git-watcher/server/internal/read-sha.ts`: transient failure → null overwrites known-good sha + spurious `refHeadResource` notify (root trigger for #3/#4) | live resource, downstream caches | WS1 |
| 6 | `getMainAhead` — `plugins/build/server/internal/git-status.ts:11-25`: `out === null ⇒ {count:0}` → `build.mainAheadCount` (hides rebuild-needed banner) | UI banner | WS1 |
| 7 | Failed `git log` → `[]` — `build-commits/server/internal/handle-build-run-commits.ts:36-38`, `compute-graph.ts:105-116` (cached) | display + cache | WS1 |
| 8 | `get-push-files.ts:46-57` — `nameStatus` failure handled right, `numstat` failure silently zeroes additions/deletions | display stats | WS1 |
| 9 | Backup gdrive retention — `backup/plugins/targets/plugins/google-drive/server/internal/retention.ts:14,32`: failed Drive list → 0 pruned, failed DELETEs dropped; caller discards return; run still `ok:true` | backup-run health signal | WS1 |
| 10 | Recovery pane — `conversations/plugins/recover/web/components/recovery-view.tsx:70,141`: raw `useQuery`, `q.data ?? []`, never reads `isError` ⇒ fetch error renders "No recently closed conversations" in the crash-recovery pane | data-recovery decision | WS1 (A3) |
| 11 | `useConversationById` — `conversations/web/use-conversations.ts:126-142`: 404 and fetch-error collapse to one `null` at ~40 sites (traced destructive-adjacent consumer fails safe) | display chips; fails safe | file task |
| 12 | pane-restore `loadRouteForConversation` — missing key / expired TTL / corrupt JSON → one null (known adjacent) | navigation mode | file task |
| 13 | Latent: `live-state-snapshot` persist — `persistSnapshot` blindly persists whatever a bootCritical loader returns; no absorbing loaders exist today, but if one appears the false-empty becomes durable boot truth | persisted snapshot | residual-risk note only |
| 14 | Silent sub-error wedge — resource-runtime `handleSub` loader-throw ⇒ client `console.error` only ⇒ `useResource` pending forever, no error surfaced | different class (invisible failure, not false-empty) | file task |

**Already safe (do not touch):** live-state push cascade (loader throw ⇒
skip, snapshot untouched — stale-safe); endpoints (`fetchEndpoint` throws
typed `EndpointError`, mutation errors auto-toast); `no-pending-data-collapse`
lint (burndown empty); worktree-cleanup reap (`getGitHygiene` catch defaults
`isDirty: true` — fail-safe); backup core (throw ⇒ run `"failed"`); mail sync
(typed `GmailHistoryExpiredError` etc.); `code-explorer/server/internal/get-file-diff.ts`
is the model producer (every `runGit === null` checked, `{kind:"error"}` returned).

## Guardrail design (layered)

### Layer A — producer convention + fix (WS1)

**Convention (the repo rule):** a fallible operation either **throws** or
returns a **discriminated result** (`{ok:true,...}|{ok:false,...}` /
`{kind:...}`). It never signals failure with `null`/`[]`/`""`/`0`/`false`
that overlaps a legitimate success value. A result union (not throw) is
warranted for exactly three shapes: probe semantics ("does this ref
exist?"), batch partial failure ("3 pruned, 2 failed"), and results that map
to HTTP statuses (`FileDiffResult` exemplar).

Concrete producer fixes:

- `runGit(args, cwd): Promise<string>` **throws `GitError`** (message
  includes args, exitCode, stderr — stderr is currently discarded). Add
  sibling `tryRunGit(args, cwd): Promise<GitResult>` with
  `GitResult = {ok:true; stdout:string} | {ok:false; exitCode:number; stderr:string}`
  for legit probes. `string|null → string` is a compile break at all ~20
  sites — **tsc enumerates the burndown**. Per-site resolution:
  - absorb sites (#1,#6,#7,#8): drop the `if (x)` guard, let the throw
    propagate — resource loaders and endpoints are already-safe surfaces
    (loader throw ⇒ stale-safe skip / HTTP 500).
  - probe sites ("ref exists", tolerate exit 1): `tryRunGit` + branch `.ok`.
  - cache-key sites (#3): throw aborts the recompute ⇒ old cache entry
    retained (stale-safe) instead of `""`-collision.
  - `readSha` (#5): keep nullable for "ref absent" (legit) but distinguish
    failure: `tryRunGit`, treat `.ok === false` as "keep last-known-good, no
    notify"; only a successful "ref absent" clears the sha.
- CLI `run` in `push.ts`: throws on non-zero exit by default (prints stderr,
  exits like `exec`); add `runAllowFail` returning `{stdout, exitCode}` for
  the sites that genuinely branch on exit code (:222, :455). Dirty-check
  (#2) then reads guaranteed-real porcelain output.
- Backup retention (#9): return `{pruned: number; failures: string[]}`;
  `run-target.ts` records failures in `targetResults` so the run reports
  degraded instead of silently `ok`.
- Recovery pane (#10): branch on `q.isError` ⇒ error + retry state
  (Placeholder tone="error"), never the "No recently closed conversations"
  empty copy.

### Layer B — lint rule `no-absorbed-failure` (WS2)

New third rule in the existing promise-safety plugin:
`plugins/framework/plugins/tooling/plugins/lint/plugins/promise-safety/lint/no-absorbed-failure.ts`
(+ registration in its `index.ts`, + `RuleTester` test file — the plugin
family precedent is `no-adhoc-git-grep.test.ts`).

Detection (all pieces proven in shipping rules):
- Visit `CatchClause` and `.catch(...)` handler bodies.
- Find reachable returned/resolved values.
- Flag when the value is an empty-default literal — `[]`, `{}`, `null`,
  `undefined`, `""`, `0`, `false` — or an identifier whose declarator init
  is one. Copy `isEmptyDefaultLiteral` / `resolveVariable` / `initializerOf`
  / `unwrap` (~50 lines) from
  `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts`
  into the new rule file (jiti forbids `@plugins/*` imports in rule files
  and the helpers live in a different plugin — duplication is the
  established pattern here).
- Escape hatches (favor false negatives, like `no-bare-catch`):
  1. catch body contains a reachable `throw` (specific-handling pattern);
  2. returned value is a discriminated object literal (has a `kind`/`ok`
     property) — the sanctioned result shape;
  3. per-site `eslint-disable-next-line` **with required reason** ("why
     empty is a real answer here, not a failure signal").
- Land as `error` repo-wide with an `ignores["promise-safety/no-absorbed-failure"]`
  burndown allowlist (mechanism exists: `build-lint-config.ts:39,276`) —
  after WS1 lands first, the allowlist should be empty or near-empty; the
  rule's contract is "migrate entries, never add" (no-pending precedent).

### Declined mechanisms (and why)

- **Type-aware lint rule** (repo's would-be first): would exist to catch A1
  nullable-absorption at consumers, but A1 is cured cheaper and completely
  at the producer; being first-type-aware carries real risk (IDE-vs-CLI
  parser divergence, program-reuse edge cases) for a class already closed.
- **Shared `Result<T,E>` primitive**: the repo is throw-first ("fail
  loudly"); jiti means the enforcing lint rule couldn't import it anyway;
  the local `{kind:"ok"}|{kind:"error"}` union idiom (≥4 files) is blessed
  and documented instead.
- **New `./equin check`**: the only lint-invisible shape (destructured
  spawn discarding `exitCode`) is cured by making `run` throw, not by a
  scanner.
- **Persist-layer guard for #13**: a hard block risks false-positive boot
  failures on legitimately-empty resources; the producer rule is the cure;
  the read-set-shrink monitor already reports sheds. Residual risk noted.

### Layer E — design-time docs

1. `.claude/skills/api-design/SKILL.md`: new short section **"Failure must
   be a type, not an absorbable value"** — throw or return a discriminated
   result; never `null`/`[]`/`0`/`""` meaning "failed" where the same value
   means "legitimately empty"; the throw-vs-result decision rule (probe /
   batch-partial / http-status → result; else throw).
2. Root `CLAUDE.md`, "Fail loudly" bullet: one added sentence cross-linking
   the rule and the skill section.

## Sequencing

1. **WS1** (producer fixes; independent of any rule, tsc-driven):
   `runGit` throw + `tryRunGit` → fix all compile-break sites
   (#1,#3,#4,#5,#6,#7,#8) → CLI `run` throw + `runAllowFail` + dirty-check
   (#2) → backup retention result (#9) → recovery-view isError (#10).
2. **WS2** (lint rule): write rule + RuleTester tests → run repo-wide to
   enumerate → land as `error` seeding the `ignores` allowlist with whatever
   remains (target: empty, since WS1 already cured the git producers where
   most A2 sites live).
3. **Docs** (Layer E) land with WS2.
4. **File tasks** (via `add_task`): #11 useConversationById null-split; #12
   pane-restore tri-state; #14 sub-error wedge (different class: invisible
   failure). Mark task-1783518959947-muil14 subsumed by WS1.

## Files

- `plugins/primitives/plugins/commit-list/server/internal/run-git.ts` (+ barrel: export `tryRunGit`, `GitError`)
- Call sites: `conversations/.../code/server/internal/get-edited-files.ts`,
  `conversations/.../commits-graph/server/internal/compute-graph.ts`,
  `review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`,
  `infra/plugins/git-watcher/server/internal/{read-sha,watcher}.ts`,
  `build/server/internal/git-status.ts`,
  `build/plugins/build-commits/server/internal/handle-build-run-commits.ts`,
  `code-explorer/server/internal/{get-push-files,get-file-diff}.ts`
- `plugins/framework/plugins/cli/bin/commands/push.ts` (`run`/`runAllowFail`)
- `plugins/backup/plugins/targets/plugins/google-drive/server/internal/retention.ts` + `run-target.ts`
- `plugins/conversations/plugins/recover/web/components/recovery-view.tsx`
- New: `plugins/framework/plugins/tooling/plugins/lint/plugins/promise-safety/lint/no-absorbed-failure.ts` + `.test.ts`; edit its `index.ts`
- Docs: `.claude/skills/api-design/SKILL.md`, root `CLAUDE.md`

## Tradeoffs (honest)

- WS1 touches ~20 sites, but each is a 1–3 line change and tsc enumerates
  them; leaving `string|null` is what produced 8 of the 14 inventory items.
- The lint rule has deliberate false negatives (a catch that returns `[]`
  in one branch and rethrows in another is allowed — that's the sanctioned
  specific-handling pattern). It may flag legitimate predicates
  (`try {...; return true} catch {return false}`) — those take a
  disable-with-reason, which is the point: the exemption is loud in review.
- No lint backstop for future A1-shaped producers (nullable-absorbed
  cross-file) — mitigated by the api-design doc at design time and by the
  fact that the two spawn wrappers that made it possible now throw.

## Verification

1. `bun test plugins/primitives/plugins/commit-list` (new `runGit`/`tryRunGit`
   unit tests incl. failure paths) + existing suites for compute-graph /
   get-file-diff if present.
2. Lint rule: `RuleTester` suite (positive: `catch{return []}`,
   `.catch(()=>null)`, `catch{return 0}`, identifier-init cases; negative:
   rethrow branch, `{kind:"error"}` return, disable-with-reason), then
   `./equin check type-check` green repo-wide; removing an allowlist
   entry re-flags.
3. `./equin build`, then behavior checks against
   `http://<worktree>.localhost:9000`:
   - Induce a git failure in a conversation worktree (e.g. transient
     `index.lock`) ⇒ exit button must NOT settle on "Drop & Close"; the
     `editedFiles` resource must error/stay stale, not publish `[]`.
   - Commits-graph ahead/behind chip under the same failure ⇒ retains last
     value, no false 0/0.
   - Recovery pane with the endpoint 500-injected ⇒ error+retry state, not
     "No recently closed conversations".
4. CLI: in a scratch worktree, make `git status` fail (chmod the index) ⇒
   `./equin push` must abort loudly, not proceed as clean; normal
   dirty tree still prints the uncommitted-changes error; `-m` flow still
   commits.
