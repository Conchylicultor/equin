# Live resources, phase 3: handoff to the agent that finishes it

This is written for an agent resuming in this worktree
(`.claude/worktrees/att-1790464521-9qff`, branch `claude-web/att-1790464521-9qff`) with no memory
of the conversation that did the work. The migration is implemented, verified and **uncommitted**. What
remains is review, integrating main, and landing it — plus a set of follow-ups to file.

## 1. Read first

- **The plan and its Result:** `research/2026-09-27-global-live-resources-phase3-bulk-migration.md`.
  - Its "Decisions" section holds the user's rulings. Do not relitigate them.
  - Its "Result" section is the authoritative summary of what landed.
- **The contract** the migration follows: `research/2026-09-26-global-live-values-migration-contract.md`.
- **The API as it is now:** `plugins/network/plugins/live/CLAUDE.md`.
- **The Resources page:** `read_page` on `block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`.
  - Its agent status card is `block-f6465fff-7a50-4812-97f3-f63fd7179b70`. Item 5 has the phase-3 status.
  - Items 3, 7 and 9 carry the deferrals this phase recorded. The user asked for these to be on the page, so keep them when you edit
    the card.

## 2. Where things stand

| | |
|---|---|
| Worktree HEAD | `47e4dc8f4` (the branch base; nothing is committed) |
| `main` | `7931162c0`, one commit ahead (type-scale role ladder — unrelated to live resources) |
| Working tree | about 741 files changed (726 modified, 15 deleted), 28 new paths |
| Deploy | `http://att-1790464521-9qff.localhost:9000`, built from the current tree (the deploy fix included), every check green |
| Pushed | **no** — the user has not approved a push |
| Second session | Steps 0, 2, 3 and 6 are done. **The branch is now integrated: HEAD is `main` at `3e2a9a0db`, and the migration is re-applied on top, still uncommitted.** Review with `git diff 3e2a9a0db` plus the untracked files. Details: the plan's "Pre-landing review (second session)". |

**What landed** (details in the plan's Result):

- **Resources:** 75 moved.
  - 44 values, 14 lookup-only collections, 15 windowed collections.
  - `slow-ops` became a GET endpoint; `prompt-task-origins` was folded into `prompt-block-tasks:rows`.
  - The old spellings remain only in the tree / revision-tick / config files (Resources page items 3 / 7 / 9) and in the substrate.
- **Guard:** `plugins/network/plugins/live/lint/` (rule `live/no-legacy-resource-spelling`) enforces that. Its `ignores` list in
  `lint/index.ts` is the 94-file inventory of what is left, grouped under "Item 3 / Item 7 / Item 9" with a `·` line naming the
  resources that keep each file there.
- **Runtime:**
  - `mode` is required on every non-keyed old server form, so the runtime's `?? "invalidate"` default is gone.
  - `ServerResourceOptions` is split: keyed options (`KeyedServerResourceOptions`) take no `mode`.
- **Deleted:** `usePointResource`, `usePointResources`, `useWindowResource`, the legacy object form of `useOptimisticResource`, and the
  `rowIdentity` scope arm.
- **Substrate:** `windowQueryResourceDescriptor` / `pointQueryResourceDescriptor` are internal to `network/live`
  (`core/internal/window-descriptor.ts`), so `resource-vocabulary` has 5 descriptor factories instead of 7.
- **New guards:**
  - a preload-declare boot assert (`server-core/core/resources.ts`, `assertPreloadedResourcesDeclared`, run in `shared/boot-stages.ts`);
  - `no-db-backed-notify` also scans `serveValue` external loaders;
  - `no-hand-rolled-entity-projection` covers `serveValue` loaders;
  - `no-reactive-server-io` watches `useLive` / `useLiveRow`.

## 3. What is left to finish, in order

0. **Done (second session): the build passed, every check included.** It was needed because the previous build predated these
   changes, made while fixing the Sonata `song-switch` e2e:
   - `plugins/apps/plugins/sonata/e2e/song-switch.ts`;
   - the new `plugins/primitives/plugins/adaptive-bar/e2e/{reach.ts, index.ts}` — a new e2e barrel;
   - a new section in `plugins/primitives/plugins/adaptive-bar/CLAUDE.md`.

   They passed type-check, ESLint, prettier and `plugin-boundaries` / `boundary-rules` on their own, but not the full check set. The
   likely failure is `plugins-doc-in-sync`: the new barrel changes the generated plugin docs, which only a build regenerates. The
   research-doc edits since then (the plan's Result, this doc, `research/2026-09-25-global-unified-live-resource-api.md`) are unlikely
   to affect any check.
1. **Wait for the user's review.** They review against the branch base:
   `git diff $(git merge-base HEAD main)`. Never push or commit on your own initiative (root CLAUDE.md). "push", "publish" and "ship"
   all mean `./equin push -m "…"` — and only when the user says so.
2. **Integrate `main`.** `7931162c0` touches seven paths this branch also changes:
   - `docs/plugins-details.md` (generated — take either side, then let the build regenerate it);
   - `plugins/conversations/CLAUDE.md`, `plugins/conversations/plugins/conversation-view/CLAUDE.md` (keep both edits; the
     AUTOGENERATED blocks regenerate);
   - `plugins/apps/plugins/studio/plugins/compositions/plugins/release/plugins/release-artifact/web/components/release-artifact.tsx`
   - `plugins/build/plugins/build-info/web/components/build-info.tsx`
   - `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx`
   - `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/event-counter/web/components/event-counter.tsx`

   For the four `.tsx` files, keep main's type-role classNames AND this branch's `useLive` / `useLiveRow` reads — they are
   independent edits to the same components. `./equin push` pulls main before merging; if it stops on a conflict, resolve these
   and re-run. Never `git merge origin/main` or `git reset` by hand (root CLAUDE.md: rebase only).

   **Done (second session), with the user's go-ahead**, onto `3e2a9a0db` — by then four commits ahead, touching ten shared paths.
   - How: reverse-apply the branch diff, `git rebase origin/main` (a fast-forward), re-apply the diff minus the shared paths, then
     `git merge-file` each shared path.
   - Eight merged cleanly. Two were resolved by hand:
     - `release-artifact.tsx`: main's `text-code` line, because the branch side was only prettier's reformat;
     - `web.generated.ts`: the union of both `dependsOn` lists, which the build regenerated identically.
   - Seven adversarial merge / interplay reviewers found nothing.
   - If `main` moves again before the push, `./equin push` pulls it itself.
3. **Done (second session).** After integrating:
   - the build passed, every check included;
   - the full suite showed only the known failures (31 this run, since the host-admission flake did not fire);
   - the six smoke scripts plus jsonl-viewer's `scroll-restore` (9/9) and `stats-verify` all pass;
   - the boot snapshot still carries `agents`, `worktree-ops`, `release.previews`, `conversations-gone-stats` and `build.history`,
     and `live_state_snapshot` still holds `agents` and `conversations-gone-stats`.

   `scroll-restore`'s default `--conv` has no transcript file on this machine, so pass a live conversation. The original
   instructions for this step:
   - `./equin test` on the touched areas. Every failure in section 6 is already known; anything else is new.
   - The e2e smoke set: `sonata/e2e/song-switch.ts` (31 checks; it needs `--song-a <id> --song-b <id>` — two songs with MIDI,
     e.g. `a672c221…` "summertime" and `5491b818…` "summertime_performance"), `page/editor/e2e/structural-write-order-verify.ts`,
     `page/editor-collab/e2e/crdt-multitab-agent-verify.ts`, `shell/notifications/e2e/bell-filter.ts`,
     `apps/events/plugins/sources/e2e/live-sources.ts`, `build/e2e/popover-logs.ts`.
4. **Land it** when the user says so: `./equin push -m "<message>"`. Suggested message:
   `feat(network/live): phase 3 — migrate every in-scope live resource to liveValue/liveCollection/useLive; legacy-spelling lint with a tree/tick/config burndown inventory; mode required (no invalidate default); window/point descriptor factories internal to network/live; usePointResource(s)/useWindowResource/legacy optimistic form/rowIdentity deleted; preload-declare boot assert. research/2026-09-27-global-live-resources-phase3-bulk-migration.md`
   Main then rebuilds itself — you never deploy main.
5. **After it lands,** update the Resources page item 5 status line (currently "uncommitted, awaiting review") to say it is on main,
   with the commit sha. Keep the item 3 / 7 / 9 sub-bullets exactly as they are.
6. **Done (second session): the section 7 follow-ups are filed**, one task per group, as a linear chain after the existing
   `runs-surface` task so they wait for this one without blocking it. The first is `task-1790505135228-2t4fa0` (stale value after a
   reconnect) and the last is `task-1790505201855-tw8c3m` (`Resource.Declare.from`). Do not file them again.

## 4. How the code is laid out now (a map)

- **`network/live`:**
  - `lint/`: the legacy-spelling rule and its burndown list.
  - `core/internal/window-descriptor.ts`: the moved factories.
  - `web/internal/use-live.ts`:
    - `useLiveRow(c, id | null)` — a null id reads the shared `{ ids: "" }` tuple and settles `found: false` on the first render;
    - list results, `loadMore` and row results are identity-stable.
  - `shared/compile-value.ts`: the `serveValue` option compilation.
- **`infra/query-resource`:** the compile substrate.
  - `queryResource` stays only for the tree resources; `windowQueryResource` sits behind `serveCollection`.
  - `compileWindowQuery` is exported from `server/testing/` (R13).
- **`primitives/live-state`:** `window-hooks.ts` is gone. `useResource` remains for the tree, tick and config readers.
- **Sonata per-song settings:**
  - `apps/sonata/plugins/shell/web/{loaded-song.tsx, song-setting.ts, song-setting-mount.tsx, score-settings.ts}`. Content and
    settings share one state with a single song id.
  - Settings register through the `Sonata.SongSetting` slot, and the score gate waits only on registered ones.
  - The track-view setting lives in `track-mixer/web/track-view-setting.ts`.
- **Editor:**
  - `page/editor/web/block-editor-context.tsx` `BlockEditorProviderGate`: the provider only ever sees a settled store; this is typed.
  - `composite-block-store.tsx`: `loadingBelow` renders a still-loading child page as a loading region.
- **The `pushes` carrier:** `tasks-core/server/internal/resources.ts` `pushesAttemptsCascade`, key `"pushes.attempts-cascade"`,
  anchors the tree `attempts` `rel()` edge. The new `pushes` collection (`pushRows`) is its future anchor (item 3).
- **E2E helper:** `primitives/adaptive-bar/e2e/reach.ts` — `reachInBar(page, control, act)` opens the `⋯` overflow when the
  control is not in the bar.

## 5. Verified only partly

These limits come from this worktree, not from skipped work. Say so in the review summary rather than presenting them as verified.

- **The `pushes.attempts-cascade` → `attempts` edge.** It is confirmed wired in the runtime registry (`/api/resources/_debug`:
  `downstream: ["attempts"]` / `dependsOn: [… "pushes.attempts-cascade"]`). It was never exercised end to end: a push row lands only
  through a real `./equin push` of a trailer commit, and no endpoint creates one. After this branch lands, check that an
  attempt's derived status and its task-events push list update when a push lands.
- **`mail-thread-messages`** — the newest-100 window, reversed in the pane, with "Load older messages". It is covered by jsdom only
  (`mail/reading-pane/web/__tests__/message-list.test.tsx`). Mail tables are `ExcludeFromFork`, so this worktree has no mail data.
  Check it on main after landing: open a thread, and a long one if one exists.
- **`build-info` / `build-fix` finding a run older than the newest 50** (the `useLiveRow` improvement). Not exercised: this
  worktree has only 6 build runs. Check it on main after landing.
- **`review.plugin-changes`.** Type-check and unit tests only: the plugin is excluded from the base composition, so no deploy
  loads it.
- **`subagent-activity`, `subagent-transcript`.** Type-check, unit tests and review only: there is no e2e script for the subagent
  pane. The jsonl-viewer scripts cover `jsonl-events`, which shares their `whileSubscribed` pattern.

## 6. Known failures — do not chase these

**Full `./equin test` (32 failing cases).** Every one fails identically on a clean checkout of `47e4dc8f4`:

- **16 DB-backed cases** — `tasks-core/.../mutations/clusters.test.ts`, `status-closure.test.ts`,
  `conversation-view/code/.../edited-files-signature.test.ts`. They pass alone.
  - Cause: `infra/entity-extensions/server/internal/define-extension.test.ts:37` `mock.module`s `@plugins/database/server`, and bun
    never undoes it for later files.
- **The rest, all pre-existing:**
  - `web-sdk/core/load-tiers.test.ts` (2), `database/core/internal/config.test.ts`, `plugin-meta/closure/core/closure.test.ts`,
    `stats/cost/.../price-table.test.ts`;
  - `debug/stuck-spans/.../detect.test.ts` (expects no `membership` span kind);
  - `infra/host/host-admission/.../grant.test.ts` (host-dependent flake);
  - `sonata/piano-roll/.../geometry.test.ts`, `prototypes/canvas/.../layout.test.ts`;
  - `lint/caret-trigger-safety/.../no-adhoc-caret-trigger.test.ts`, `checks/type-check/check/prepare-thread.test.ts`;
  - `fields/enum/table/web/__tests__/enum-cell.test.tsx` (4), and `jsonl-viewer/.../instructions-view.test.tsx` (`import.meta.dir`
    under vitest).

**E2E failures that also happen on main:**

- `chord/curriculum-verify` ("practising vi adds its answer button");
- `prototypes/canvas-version` (documented known gap), `prototypes/present-verify` (design chip);
- `config_v2/.../conflict-agent-verify` (its `--path` collides with the harness flag);
- `prompt-templates/usage-order` (click intercepted by a floating-action container);
- `launch-options-verify` (Prerequisite popover), `deploy/remote-deploy-verify`, `page/prompt/block/prompt-launch`;
- `queue/e2e/queue-reorder.ts` (7/11 — `49a1e10d3` made its drag math stale);
- `crdt-adjacent-surfaces-verify` (3/5 baseline).
- **Flaky:** `outline/toc-lands-on-right-message` (settle timing under load), `chord/piano-shot` (instrument race),
  `bell-filter` (live notification traffic).

**To classify a new failure,** re-run the same script against main with `--url http://singularity.localhost:9000`. Main runs the
PRE-migration code, because nothing here is committed.

**Slow-op reports** for per-row `:rows` / `pushes` first loads are pre-existing: main has about 14.8k of them under the old keys.

## 7. Follow-ups found, ready to file

Pre-existing unless marked. Each names where the fix belongs.

1. **Stale value after a same-boot reconnect.** An external value whose `notify` is wired only in `whileSubscribed` and that has no
   `revalidate` answers `up-to-date` from memory on replay, although nothing tracked changes in between (`queue-health.pulse` — a
   wedged queue stays green; `jobs-list`; `allow-files`). Fix it in `network/live/shared/compile-value.ts`: exclude such values from
   the version short-circuit, or mark the tuple stale when the pairing stops.
2. **Every transcript open pushes the whole `jsonl-events` value twice** — the sub-ack, then the watcher's first notify, about
   1 MB. The fix is in the `whileSubscribed` start in `jsonl-viewer/server/internal/jsonl-events-resource.ts`: skip the notify when
   the primed signature equals the served one.
3. **`initialData` leaves `ResourceDescriptor`.** This is recorded on the Resources page under item 9.
   - The `network/live` substrate part can be done NOW: mint the window / point / `:groups` descriptors without a placeholder.
   - The rest waits for items 3 / 7 / 9.
4. **Test-isolation leak:** `define-extension.test.ts:37`'s `mock.module` of `@plugins/database/server`. Inject the db into
   `defineExtension`, or add a check banning `mock.module` of shared barrels.
   - A second instance (found in the second session, also on the clean base): `shell/toast/web/internal/live-toasts.test.ts`'s
     `mock.module("react", …)` misses in a full run ("Unhandled error between tests … the stub missed it"). It passes alone. The same
     check would catch it.
5. **77 RuleTester suites lack bun `describe` / `it` wiring.** The precedent is
   `database/connection/lint/no-raw-pg-connection.test.ts:11-21`. Without it, failures surface only as "Unhandled error between
   tests". Wire them, or add a check that enforces the wiring.
6. **E2E and harness:**
   - `queue-reorder.ts`: use the sliding drag model (drop on the target row's centre, as `data-view/list/e2e/sortable-reorder.ts` does)
     and drop the indicator checks.
   - `toc-lands-on-right-message.ts`: wait on `scrollend`, armed right before the click.
   - `conflict-agent-verify.ts`: rename its `--path`.
   - `screenshot.ts --click`: it resolves an app-rail button before a tab of the same name.
   - `remote-deploy-verify.ts`: it looks for the composition name without expanding the collapsed Deployments card, so it times out.
     This is why the script also fails on main.
   - `song-switch.ts:271`: two `no-unnecessary-condition` warnings.
   - The song-switch frame sampler could move to a MutationObserver, so a one-frame leak cannot fall between samples.
7. **Sonata:** the chord-grid / ultimate-guitar persist observers pair `currentSongId` with the loaded song's content. A debounce masks a
   wrong-song save today. Expose the loaded song id (`loaded-song.tsx`) to them.
8. **`page-blocks` edge cases (NEW with this branch):**
   - an op aimed at a still-loading child page throws (`composite-block-store.tsx` `dispatchFor`);
   - a child page whose load fails shows loading, and the error appears only in `sync-status`;
   - an in-place `pageId` change remounts the editor provider (focus and undo entries drop).
9. **Data-view:** `FieldExtensionProps.render` has no loading state, so custom columns, starred, agent-origin and source-field
   show a default while their data loads.
10. **Smaller:**
    - `Resource.Declare.from` / `getContributionsIfCollected` are typed but `undefined` at runtime (`server-core/core/resources.ts`);
    - `agent-detail.tsx` shows loading forever for a deleted agent;
    - the SSH-setup card opens by default while health loads (`useDefaultOpen` takes only a boolean);
    - the `review` pane shows its push spinner forever for a deleted conversation (`useConversationById` conflates loading and
      missing — item 3);
    - the `build.history` "Run not found" path for runs older than the newest 50 was not exercised: this worktree has only 6 runs.

## 8. Mechanics and gotchas

- **Framework approval was given for phase 3 in the original conversation only.** Any new change under `plugins/framework/` needs
  the user's approval in YOUR conversation (`plugins/framework/CLAUDE.md`).
- **The lint allowlist** (`plugins/network/plugins/live/lint/index.ts`):
  - Never add an entry for new code.
  - `lint/index.test.ts` fails when a listed file no longer imports an old spelling, so remove a file's entry when you migrate it.
  - The item section headers read `// Item N (…) — …`. A script that parses them must allow the parenthesis.
- **Ops:** `./equin test`, `check` and e2e runs are ops. Run them with `run_in_background: true` and end your turn; a subagent
  calls `./equin await <op>` in the foreground instead.
- **Formatting trap:** the build prettier-formats every changed file and REFUSES when a positional `eslint-disable-next-line` would
  move. Keep such directives above a line already in prettier's shape, or use block form outside JSX.
- **Data the e2e runs changed:**
  - the conversation queue (main and this worktree) was re-ordered back by the UI, but its rank strings changed;
  - Sonata song "sunny-roberto-piano-v2" (`03ab2083…`) gained two plays and default-valued transpose / chord-mode rows;
  - song "summertime" (`a672c221…`) gained plays.
- **Scratch data:** the census data behind the plan was session scratch (`/private/tmp/...`) and may be gone. The plan and this doc
  are the durable record.
