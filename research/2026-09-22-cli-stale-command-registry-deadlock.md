# Deleting a CLI command must not brick `./equin`

## Context

Deleting a command plugin (`plugins/framework/plugins/cli/plugins/<name>/`) makes
every `./equin` invocation crash at startup, `build` and `push` included:

```
error: 1 cli command contribution(s) failed to load:
    framework/plugins/cli/plugins/apply-migrations — loader threw: Cannot find package '@plugins/framework' …
```

Why:

- `bin/cli.ts` loads every entry of the generated registry
  `plugins/framework/plugins/cli/core/cli.generated.ts` through
  `loadCollectedDir(…, { strict: true })` before it parses argv. Strict mode turns
  any loader rejection into a startup failure.
- The registry still lists the deleted command, because the only thing that
  regenerates it is the CLI (`build`, `regen-generated`).
- `push` makes it worse: after the rebase, the `regen-generated` merge driver
  resets `*.generated.ts` to main's side (which still lists the command), then
  `normalizeGeneratedArtifacts` spawns `bun …/bin/index.ts regen-generated` to
  repair it — and that subprocess crashes on load. A hand edit cannot survive the
  reset, so the deletion can never land (branch `claude-web/att-1789936487-t8yi`,
  commit `bcac38e72`, is stuck on this).

Strict mode exists for a real reason: a `cli/index.ts` that is **present but
throws** must not make its verb quietly vanish (`build` reading as "unknown
command"). But it lumps in a different case: an entry whose **source file is gone**.
That entry is not broken — it is a stale line in a derived file, and the command
it names really does not exist. Treating the two the same is the bug.

## Approach

Teach the collected-dir loader the difference between a *stale* entry and a
*failed* one, and have the CLI use it.

### 1. `loadCollectedDir` gets a presence predicate

`plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts`

- New option `isPresent?: (entry: CollectedEntry) => boolean`. Injected, so the
  leaf keeps zero `node:*` / cross-plugin imports (web consumers still load it).
- Entries for which `isPresent` returns false are **not loaded at all** and are
  never strict failures. They are collected into a stale list and reported once
  on stderr, e.g.
  `[cli command] registry lists 1 removed contribution(s), skipped: framework/plugins/cli/plugins/apply-migrations — ./equin build regenerates the registry.`
- Everything else keeps today's semantics: under `strict`, a present entry whose
  loader throws, or whose default export is missing/invalid, still fails the pass.
- Extend the option docblock: strict answers "present but broken"; `isPresent`
  answers "listed but deleted".

### 2. The CLI passes it

`plugins/framework/plugins/cli/bin/cli.ts`

- Pass `isPresent: (e) => existsSync(cliEntrySource(root, e))`, where root is
  derived from the bin file's own location (`import.meta.dir`), not the cwd.
- Put `cliEntrySource(root, entry)` → `<root>/plugins/<pluginPath>/cli/index.ts`
  in `plugins/framework/plugins/cli/core/` so `bin/cli.ts` and the
  `cli:command-declarations-light` check (`cli/check/index.ts:~421`, which
  already hand-joins the same path) share one spelling. The check and
  `cli:command-names-unique` should skip absent entries the same way, so
  `./equin check` on a tree with a stale registry reports only the
  `plugins-registry-in-sync` drift, not a crash.

Cost: one `existsSync` per command (~20) per invocation — negligible next to
the imports it guards.

### Why this closes both halves

- `build`: startup skips the stale entry, codegen rewrites the registry.
- `push`: after the driver resets the registry to main's copy, the
  `regen-generated` subprocess starts (stale entry skipped), regenerates the
  registry from the merged sources, and `normalizeGeneratedArtifacts` amends it.
  No hand edit needed.
- Nothing becomes silent: the stale line is announced on every run until the
  registry is regenerated, and the existing `plugins-registry-in-sync` check still
  blocks landing a stale registry.

### Not doing

- Replacing the generated registry with a startup filesystem walk: registration
  depends on the file's content (a `cli/index.ts` with no default export, like
  `op-runtime/cli`, is not a command), and the registry is also the check's
  subject list. The generated file is fine; only the loader's reading of a
  missing source was wrong.
- Classifying by error message (`ERR_MODULE_NOT_FOUND`): a present declaration
  with a broken import throws the same code, and must still fail.

## Files

- `plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts` — `isPresent` option + stale reporting
- `plugins/framework/plugins/cli/core/` — `cliEntrySource` helper (exported from the core barrel)
- `plugins/framework/plugins/cli/bin/cli.ts` — pass `isPresent`
- `plugins/framework/plugins/cli/check/index.ts` — reuse the helper; skip absent entries
- `plugins/framework/plugins/cli/CLAUDE.md` / collected-dir `CLAUDE.md` prose — one paragraph on stale vs failed

## Verification

1. Unit test next to the loader (`load-collected-dir.test.ts`): with `strict`,
   an absent entry is skipped and reported; a present entry whose loader throws
   still throws; a present entry with no default export still throws.
2. Reproduce the `build` half in this worktree: temporarily delete a small
   command folder (e.g. `serve-app`) without touching `cli.generated.ts`, then run
   `./equin check plugins-registry-in-sync` (should start, report drift) and
   `./equin regen-generated` (should start and drop the line). Restore the
   folder with `git checkout`.
3. Reproduce the `push` half: with the folder deleted and the registry
   regenerated, `git checkout main -- plugins/framework/plugins/cli/core/cli.generated.ts`
   (what the merge driver does), then `./equin normalize-generated`-equivalent
   path: `bun plugins/framework/plugins/cli/bin/index.ts regen-generated` must
   succeed and rewrite the registry. Restore everything afterwards.
4. `./equin test plugins/framework/plugins/tooling/plugins/collected-dir`, then
   `./equin build`.
5. After this lands on main, the stuck branch `att-1789936487-t8yi` rebases and
   pushes without the hand edit.
