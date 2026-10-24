# Persist drizzle create-vs-rename answers so push's regen can replay them

## Context

`./equin push` has a post-rebase **normalize** step. When a concurrent migration
lands on `main`, the `regen-migrations` git merge-driver fires during rebase, drops a
marker file, and `postRebaseNormalize` (`plugins/framework/plugins/cli/bin/commands/push.ts:153`)
runs the `regen-migrations` command. That command
(`plugins/framework/plugins/cli/bin/commands/regen-migrations.ts:90`) calls
`generateMigration({ resetMigration: true })` (`plugins/framework/plugins/cli/bin/migrations.ts:331`)
with **no `migrationAnswers`**.

When a branch **replaces** a table (drop table A + create table B — e.g. renaming a
plugin's table, or restructuring a plugin so its old table disappears and a new one
appears), drizzle-kit emits an interactive *"Is B created or renamed from A?"* prompt: it
can't disambiguate drop+create from a rename. At authoring time the agent resolves this
with `./equin build --migration-answers '[{"action":"create"}]'`. **But that answer
is thrown away** — it lives only in the `migrationAnswers` parameter, never persisted. So
during push's regen, drizzle re-hits the same ambiguity; `generateMigration` detects
prompts with no answers (`migrations.ts:400`), discards the generated files, prints
`MIGRATION_PROMPTS_DETECTED`, exits 2, and **the push aborts**. Under active main
contention the branch becomes effectively un-pushable (observed while landing the
`config_v2` staging generalization: `reorder_staged_default` dropped + `staged_config_default`
created).

The create/rename decision is knowable at authoring time but is discarded and re-prompted
on every regen. **Fix: persist the decision as a sidecar next to the migration, keyed by
entity identity, so regen replays it automatically.**

A related *secondary* symptom — a consolidating regen leaves the worktree DB drifted (the
new migration's unguarded `DROP` fails on boot) with no first-class CLI reset path — is
**deferred to a follow-up** (see end).

## Why keyed (not positional) persistence

`--migration-answers` is positional (one answer per prompt, in detect-mode order). That is
fine for a single authoring `generate`. But `regen-migrations` runs with
`resetMigration: true`, which drops **all** branch-local schema migrations and re-emits one
**consolidated** migration — its prompts may differ in order/count from the original
authoring run. Positional replay is therefore unsafe. The persisted form must be keyed by
the prompt's **entity identity** (`table:<name>`, `column:<table>.<name>`, `enum:<name>`, …),
derived from `DetectedPrompt.entityType` / `entityName` / `context`.

## Design

A sidecar file `meta/<migrationTag>_answers.json` parallels the existing
`meta/<tag>_snapshot.json`. Only schema migrations that actually showed prompts get one (so:
rare, table-replacement migrations only). Format:

```json
{
  "version": 1,
  "answers": [
    { "key": "table:staged_config_default", "entityType": "table",
      "entityName": "staged_config_default", "action": "create" }
  ]
}
```

(`rename` entries carry `"action":"rename","from":"<source>"`.)

The sidecar rides git exactly like the snapshot: branch-local while authoring, merged to
main on push, immutable thereafter. `regen` only reads sidecars for **branch-local**
migrations (not tracked on `origin/main`), so main's accumulated sidecars are correctly
ignored — no cross-contamination.

### Data flow

- **Authoring** (`build --migration-answers …`): positional resolution unchanged. After a
  successful generate that had prompts, derive the keyed sidecar by pairing
  `result.detectedPrompts[i]` with `migrationAnswers[i]` and write it for the new migration.
- **Regen** (`regen-migrations`, i.e. `generateMigration({resetMigration:true})`): before the
  reset deletes anything, read+merge branch-local `*_answers.json` into a keyed map; resolve
  each re-emitted prompt by its key; write a fresh sidecar for the consolidated migration so
  repeated regens keep working. **`regen-migrations.ts` needs zero changes.**
- **New ambiguity post-rebase** (a prompt with no key in the map): discard + exit 2 with a
  "re-author via `build --migration-answers`" message. Correct loud failure.
- **Stale extra keys** (a change that's no longer ambiguous after rebase): simply never
  looked up — harmless.

## Changes (exact insertion points)

All paths relative to repo root.

### `plugins/framework/plugins/cli/bin/migrations.ts`

1. **Types / helper** (near `MigrationAnswer`, after line 33): add a `promptKey(p: DetectedPrompt): string`
   helper — `column` → `column:${context}.${entityName}`, otherwise `${entityType}:${entityName}`.
   Extend `DrizzlePromptResult` (lines 35–40) with `unanswered: string[]`.

2. **`runDrizzleKitWithPrompts`** (signature lines 146–153; resolution in `flushPrompt`
   lines 182–203): add `keyedAnswers?: Map<string, MigrationAnswer>` to opts. When set,
   resolve each prompt via `keyedAnswers.get(promptKey(prompt))`:
   - found → existing `resolveAnswer`, but **wrap its throw** (rename-source-missing) to
     push the key onto `unanswered` instead of `proc.kill()` — clean discard, not a hard kill.
   - missing → push the key onto `unanswered` and advance with option 0 (keep discovering).
   Return `unanswered`. (Positional `answers` and `keyedAnswers` are mutually exclusive.)

3. **`generateMigration`** (lines 331–473):
   - **Read sidecars BEFORE reset** — after name validation (line 346), *before*
     `resetBranchLocalMigrations` at line 351: if `resetMigration && !migrationAnswers`, build
     `keyedAnswers` by reading every branch-local `*_answers.json` (skip files in
     `listTrackedMigrationBasenames(origin/main)`) and merging into one `Map`. **This ordering
     is load-bearing** — the reset (step 5 below) deletes the sidecars.
   - At the `runDrizzleKitWithPrompts` call (lines 375–385): pass `keyedAnswers` when present;
     keep `answers: migrationAnswers ?? null` for the authoring path.
   - **New discard branch**, sibling to lines 400–417: if keyed mode and
     `result.unanswered.length > 0` → compute `added` (as lines 401–403), `removeGeneratedFiles`,
     print the "re-author via `build --migration-answers`" guidance, `process.exit(2)`.
   - **Write the sidecar** in the post-rename block (after line 451, alongside the snapshot-drop
     logic at 463–472): pick the single `renamed` entry whose `meta/<tag>_snapshot.json` exists
     (that uniquely identifies the schema migration), pair `result.detectedPrompts` with their
     resolved answers (positional `migrationAnswers` or the keyed map), and write
     `meta/<r.to.slice(0,-4)>_answers.json`. Only when `result.detectedPrompts.length > 0`.

4. **`resetBranchLocalMigrations`** (lines 524–570): in the `.sql` removal loop (540–549), when
   deleting a branch-local schema `.sql`, also `rmSync` its `meta/<tag>_answers.json`. Only for
   files already being deleted (never tracked ones).

5. **`removeGeneratedFiles`** (lines 661–676): after removing the snapshot (line 673), also
   remove `meta/<f-without-.sql>_answers.json`, so discarded generates leave no orphan sidecar.

### `plugins/framework/plugins/cli/bin/commands/build.ts`

- No signature change. `migrationAnswers` still flows positionally (lines 750–759); the sidecar
  write inside `generateMigration` handles persistence for the authoring path.

### `.gitattributes`

- After line 22, add:
  `plugins/database/plugins/migrations/data/meta/*_answers.json   merge=regen-migrations`
  (Distinct-filename sidecars don't git-conflict; this is for consistency so any same-path
  collision routes through regen rather than leaving a conflict marker.)

### Reuse (do not re-implement)

- `listTrackedMigrationBasenames(root, ref)` / `resolveMainRef(root)` (`migrations.ts:588`, `:584`)
  — branch-local detection.
- `resolveAnswer` (`migrations.ts:115`), `DetectedPrompt` / `MigrationAnswer` types (`:22`, `:31`).
- `regenerateJournal` / `renameMigrations` (`migrations.ts:687`, `:618`) — unchanged.

## Verify during implementation

- **`migrations-in-sync` check** (`plugins/framework/plugins/tooling/plugins/checks/plugins/migrations-in-sync/check/index.ts`)
  feeds 20 blind Enter keystrokes and fails if `PROMPT_RE` matched at all. It regenerates from
  `tables.ts` into a fresh tmp tree **with the consolidated migration + its snapshot already on
  disk** — so once the snapshot encodes table B, drizzle should see no delta and not prompt, and
  the check passes. **Confirm drizzle does not still prompt with the snapshot present.** If it
  does, the check would also need the keyed-answer treatment (out of scope unless observed).

## Testing / verification

There are no existing tests for `migrations.ts`. Add a co-located `bun:test` file
`plugins/framework/plugins/cli/bin/migrations.test.ts` covering the pure helpers:
- `promptKey` for table / column / enum prompts.
- keyed sidecar round-trip: build a keyed map → resolve a `DetectedPrompt` → correct option index;
  missing key → reported unanswered; stale rename `from` → reported unanswered (not a throw).

Run: `bun test plugins/framework/plugins/cli/bin/migrations.test.ts` (after a `./equin build`
or `bun install` so `node_modules` is populated).

End-to-end (manual, the real bug):
1. On a fresh worktree, replace a small table in a plugin's `tables.ts` (drop one, add another).
2. `./equin build --migration-name replace_tbl` → observe `MIGRATION_PROMPTS_DETECTED`, then
   `./equin build --migration-name replace_tbl --migration-answers '[{"action":"create"}]'`.
   Confirm `meta/<tag>_answers.json` is written next to the snapshot.
3. Land any unrelated migration on `main` (second worktree) to force the rebase→regen path.
4. `./equin build` then `./equin push` on the first worktree. Confirm
   `postRebaseNormalize` → `regen-migrations` regenerates the consolidated migration **without**
   re-prompting (replays the sidecar), rewrites a fresh `_answers.json`, and the push **succeeds**.
5. Negative: introduce a genuinely new ambiguity not in the sidecar and confirm regen exits 2 with
   the re-author guidance (loud failure, no silent wrong SQL).

## Deferred follow-up (separate task)

`./equin db reset` — drop the current worktree DB and re-fork from `singularity` (main) so
the consolidated migration re-applies cleanly, fixing the post-regen drift. Primitives already
exist: `dropDatabase` (`plugins/database/plugins/admin/server/internal/databases.ts:27`),
`forkDatabase` (`…/fork.ts:20`, idempotent), the `database.fork` graphile job, and `waitForDatabase`
(`build.ts`). Subtlety: **drop must complete before the fork enqueues** (fork no-ops if the
canonical DB exists), and the CLI can't reach the admin pool directly (needs a drop endpoint/job).
~half-day. File via `add_task`.
