# Auto-applying Prettier

Date: 2026-08-06
Category: global (cli, tooling/codegen, tooling/checks, tooling/lint)

## Context

The repo has no formatter today — no prettier dependency, no config, no editor
enforcement. Style is consistent-ish because Claude's natural output is
prettier-shaped, but it drifts: measured against prettier defaults, **53% of
`.ts`/`.tsx` files differ** (5% sample, 316 files → 166 differing, 3,132 changed
lines; extrapolated ~3,300 files / ~63,000 lines repo-wide).

The intended outcome is that formatting stops being a thing anyone thinks about:
an agent writes code, `./equin build` normalizes it, and the diff a human
reviews is already clean. The constraint that shapes the entire design is
**where** the formatter runs, because two caches key on source bytes:

- `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts:4` — check
  results are cached on the whole working-tree hash: *"ONE changed byte anywhere
  re-runs all ~62 checks."*
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/hash.ts` +
  `core/internal/own-files.ts:97` — web artifacts are content-addressed on each
  plugin's own source bytes, fingerprinted via `(mtimeMs, size)`.

A formatter that runs *after* either of those hashes is a cache bomb. So
formatting must be the **last writer before anything hashes**.

## Settled decisions

1. **`build` is the single writer.** `check` and `push` gate but never write.
2. **No per-edit `PostToolUse` hook.** It stales the agent's file snapshot and
   forces full re-reads — a context cost far larger than the diff noise itself.
3. **Allowlist, not denylist.** Nothing is formatted by default; `.ts`, `.tsx`,
   `.mts`, `.cts` opt in. **Markdown must never be added.** JSON/JSONC deferred.
4. **Changed-files-only.** Scope is `git diff $(git merge-base HEAD main)`. No
   big-bang sweep — a 3,300-file commit would conflict with all 84 live
   worktrees. Consequence: untouched files stay unformatted indefinitely.
5. **Prettier defaults for hand-written source.** Measured line-length p90 = 80,
   p95 = 82 — the repo is already de-facto written at printWidth 80, so defaults
   produce the smallest possible migration diff. Wider settings *increase* drift
   (sampled: 80 → 9/25 files differ, 120 → 16/25).
6. **`*.generated.ts` are formatted**, at a wide printWidth — see the open
   decision at the end, which the measurements below reopen.

No `eslint-config-prettier` is needed: `eslint.config.ts` carries zero stylistic
rules, only semantic and plugin-contributed ones.

## Design

### A. The format primitive

New tooling sub-plugin, mirroring `codegen` / `checks` / `web-artifacts`:

```
plugins/framework/plugins/tooling/plugins/format/
  core/index.ts                    the only public surface
  core/internal/prettier.ts        memoized dynamic import + fixed options
  core/internal/changed-files.ts   merge-base diff (shared with the check)
```

`core/` and not `server/`: the check runner reaches core barrels only.

The allowlist must be unbypassable, so there is **no content-only entry point
and no `parser` parameter** — every call names a file, and the extension decides:

```ts
export const FORMATTABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
export function isFormattable(file: string): boolean;

/** Format `source` as if it lived at `file`. Pure — never reads, never writes.
 *  Returns `source` UNCHANGED when the extension is not in the allowlist, so a
 *  caller cannot format a `.md` by calling it anyway. */
export async function formatSource(file: string, source: string): Promise<string>;

/** Formattable files changed vs merge-base(HEAD, main), plus untracked. */
export async function listChangedFormattableFiles(root: string): Promise<string[]>;

/** Read → format → write-iff-different. Called by build.ts and by
 *  `./equin format`. Returns the paths actually rewritten. */
export async function formatChangedSources(opts: {
  root: string; log?: (line: string) => void;
}): Promise<{ formatted: string[] }>;

/** Read → format → compare. NEVER writes. Called by the check only. */
export async function findUnformatted(root: string, files: string[]): Promise<string[]>;
```

**In-process Node API, not a spawned CLI.** This is forced, not preferred: the
generated-file funnel (§C) formats one file per emit site, and
`plugin-registry-gen` alone writes once per discovered collected dir. At the
measured ~500 ms per `bunx prettier` invocation that would add tens of seconds
to every build.

`internal/prettier.ts` memoizes a **dynamic** import:

```ts
let mod: Promise<typeof import("prettier")> | null = null;
function prettier() { return (mod ??= import("prettier")); }
```

Dynamic is load-bearing, not style. Static imports hoist above every statement,
so a static `import "prettier"` reachable from codegen core would resolve out of
the very `node_modules` that `ensureDeps()` exists to repair — the same rule the
`cli:bootstrap-package-free` check enforces on `bin/index.ts`. Lazy also means a
build whose changed set has no `.ts` pays nothing.

**Config is hardcoded, not resolved.** `formatGenerated` (writer) and the
in-sync checks (reader) must produce byte-identical output; a per-file
`resolveConfig()` walk is a way for them to diverge. Ship a root `.prettierrc`
so editors agree, with a header saying the build does not read it — the
authority is `FORMATTABLE_EXTENSIONS` + the options object in `format/core`.
Pass `parser: "typescript"` plus `filepath` (that is what enables JSX for
`.tsx`).

**Paired lint rule.** Repo idiom is to pair a chokepoint primitive with a rule
banning the underlying tool — `spawn-safety/no-raw-bun-spawn`,
`git-grep-safety/no-adhoc-git-grep`, `sink-safety/no-adhoc-file-sink`. Add
`plugins/framework/plugins/tooling/plugins/lint/plugins/format-safety/` with
`no-adhoc-prettier`, firing on: an import of `"prettier"` / `"prettier/*"`; a
spawn argv beginning `["prettier"]` / `["bunx","prettier"]` / `["npx","prettier"]`
(reuse `isSpawnCallee` from `no-adhoc-git-grep`); and `prettier` in *command
position* in a shell string (anchored `/(?:^|[\n;&|])\s*(?:bunx\s+|npx\s+)?prettier\b/`,
not `.includes`, so the rule can name its own banned token without self-flagging).
`create()` returns `{}` inside the format plugin's own directory, matching
`SPAWN_PLUGIN_DIR`.

### B. Where the format step goes in `build.ts`

Insert between `build.ts:994` (`clearMergeMarkers(root)`) and `build.ts:996`
(the propagate-config block):

```ts
clearMergeMarkers(root);                                        // L994 existing

// LAST WRITER TO THE REPO TREE. Generated artifacts above are already
// prettier-shaped (writeGenerated); this covers hand-written source, scoped to
// this branch's diff vs main. Must run after ALL codegen writes and before
// anything hashes: the check cache keys a PASS on the whole working-tree hash
// (checks/core/read-set.ts) and web-artifact keys are the plugin's own source
// bytes (web-artifacts/core/hash.ts).
const endFmt = buildProfilerStart("formatSources", "build:codegen", "format changed sources");
const fmt = await formatChangedSources({ root, log: (l) => console.log(l) });
endFmt();
```

Why here: after `clearMergeMarkers`, which is the point build declares every
generated artifact re-derived; well before the check companions (~L1065) and
`buildAndPublishWebDist` (~L1107), which is the hard requirement. Not inside the
stage-3 host grant — this is tens of milliseconds of single-threaded I/O, not a
heavy job.

**It goes in `build.ts`, not in `generateAppSources`.** That shared stage has a
second caller, `build-composition.ts:174`, which `release.ts:734` shells out to.
A *release* must not reformat hand-written source in the checkout, and it lands
after `release.ts:689` has already read `readGitProvenance(root)` for the
dirty-worktree stamp. The genuinely shared piece is the funnel (§C), which every
caller gets through the emitters.

**`regen-generated` must NOT format hand-written source.** It runs inside push's
normalize path followed by `git add -A && git commit --amend`
(`normalize-generated.ts:70`); formatting there would amend reformatted human
code into a landing commit nobody reviewed. This is the same reasoning that
keeps `seedAuthoredOverrides` out of the shared pipeline — write it into the
docblock so nobody "unifies" it later. It still emits prettier-shaped *generated*
files automatically, via the funnel.

Interactions: the pass runs inside `acquireArtifactLock` (L790), so no
concurrent build races it. It never moves HEAD, so it cannot trigger supersede
detection (`headAtStart`, L803). It runs regardless of `--skip-checks` — it is
not validation. **No `--no-format` flag and no env kill switch**: every escape
hatch is a way for the tree to drift out of the state `format-clean` asserts.

### C. The generated-file funnel

The write idiom `if (next !== existing) writeFileSync(file, next)` is duplicated
at **13 sites**. Replace all of them with one funnel in
`plugins/framework/plugins/tooling/plugins/codegen/core/write-generated.ts`:

```ts
/** The exact bytes that would be written for `file`. Formats iff the extension
 *  is in FORMATTABLE_EXTENSIONS — so `.md` (docgen) and `.jsonc`
 *  (config-origin-gen, authored-override-seed) route through this SAME funnel
 *  and are returned unchanged. No special-casing, no per-emitter opt-in. */
export async function formatGenerated(file: string, content: string): Promise<string>;

/** The ONE write idiom for every generated artifact. Write-on-difference is
 *  load-bearing: web-artifacts fingerprints on (mtimeMs, size), so an
 *  unconditional write would invalidate an artifact whose bytes never changed. */
export async function writeGenerated(file: string, content: string): Promise<void>;
```

**Refinement to the original "format inside `renderX`" idea.** The invariant
(emitter output and check expectation must agree byte-for-byte) is right, but
applying `formatGenerated` on *both* sides is strictly better than formatting
inside the eight render functions: one owner of the on-disk byte format instead
of two, eight fewer call sites to forget, and no sync→async conversion for
`renderCustomUtilities`, `renderBarrelStubs`, `renderCollectedDirRegistry`.
Verified safe: the only external consumers of all twelve `render*` exports are
their paired checks — nothing else in the repo calls them.

Each check becomes:

```ts
if (readFileSync(file, "utf8") !== (await formatGenerated(file, renderX(...)))) { … }
```

Write sites to migrate:

| File | Line(s) | Ext |
|---|---|---|
| `custom-utilities-gen.ts` | 269 | `.ts` |
| `data-views-gen.ts` | 151 | `.ts` |
| `fields-eager-gen.ts` | 108 | `.ts` |
| `eager-tier-gen.ts` | 359 | `.ts` |
| `token-group-vars-gen.ts` | 161 | `.ts` |
| `reorderable-slots-gen.ts` | 236 | `.ts` |
| `plugin-registry-gen.ts` | 409, 516 | `.ts` |
| `barrel-stubs-gen.ts` | 186 | `.ts` |
| `pre-barrel-manifests.ts` | 107 | `.ts` (partial funnel, 5 of 8) |
| `docgen.ts` | 302, 310, 312 | `.md` → identity |
| `config-origin-gen.ts` | 419 | `.jsonc` → identity |
| `authored-override-seed.ts` | 174, 233 | `.jsonc` → identity |

Two write sites that must **not** migrate: `config-origin-gen.ts:457` (that is
`fileConfigProxy.write`, the user-config layer under `~/.singularity/`), and
`docgen.ts`'s `unlinkSync` (a delete).

**The easy-to-miss second comparison site:** `pre-barrel-guard.ts`
`assertPreBarrelManifestsFresh` compares `m.render(root)` to disk at first
barrel import. It is not a `*-in-sync` check and won't show up in a grep for
one. It must also compare against `formatGenerated(...)` or it throws spuriously
on every build.

Checks to wrap: `app-css-utilities-in-sync:44`, `barrel-stubs-in-sync:37`,
`plugins-registry-in-sync:32`, `eager-tier-in-sync:32`, `data-views-in-sync:27`,
`fields-eager-in-sync:27`, `token-group-vars-in-sync:28`,
`reorderable-slots-in-sync:51`, plus `plugins-doc-in-sync:41/48/61` and
`config-origins-in-sync:64` (no-ops today — wrap them anyway so "everything goes
through the seam" stays uniform).

Because writer and checker call the same function, they cannot drift and land in
the same commit by construction. The one hard atomicity requirement is that when
`*.generated.ts` enters the format set, the reformatted files land in the **same
commit** — otherwise main's committed registries disagree with the emitter and
every in-sync check is red until someone builds.

### D. The `format-clean` check

`plugins/framework/plugins/tooling/plugins/checks/plugins/format-clean/check/index.ts`,
bare id `format-clean` (the `<plugin>:<id>` convention is only for checks
contributed by domain plugins). Discovery is automatic via `check.generated.ts`.

```ts
const check: Check = {
  id: "format-clean",
  description: "every .ts/.tsx changed on this branch matches prettier's output",
  // Impure: reads git REFS (merge-base with main), which the working-tree hash
  // does not cover. Fold the merge-base sha in so a moved main re-runs; degrade
  // to null on any git failure. Mirrors migration-applies-clean's signature.
  cacheSignature() { /* git merge-base HEAD main, try/catch → null */ },
  async run() {
    const root = await getWorktreeRoot();
    const files = await listChangedFormattableFiles(root);  // SHARED with build
    if (files.length === 0) return { ok: true };
    const bad = await findUnformatted(root, files);
    if (bad.length === 0) return { ok: true };
    return { ok: false, message: /* first 20 paths + count */,
             hint: "Run `./equin format`, or `./equin build`." };
  },
};
```

`scope` stays default `"tree"` so it is in push's `--scope tree` payload.
**Not `inputKeyed`** — that requires the entire transitive read surface to route
through the recording `FileSystemView`, and this check's first read is
`git merge-base`, a ref read the view cannot observe. Setting it would be exactly
the stale-PASS hole `read-set.ts` warns about. Not `alwaysRun` — on the build
path it is structurally green.

**The changed-set implementation is shared with build**, in
`format/core/internal/changed-files.ts`. If the two computed different sets the
build would format one and the check assert another. Port the idiom from
`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/compute-edited-files.ts:78-110`,
but over `spawnCaptured` from `@plugins/infra/plugins/spawn/core` (raw
`Bun.spawn` is lint-banned; `git-read-cache` is server-only and unusable here):

1. `git merge-base HEAD main` → base sha. Failure **throws** — do not invent a
   fallback ref (`compute-edited-files.ts:73` documents why).
2. `git diff -M -z --name-only --diff-filter=ACMR <base>` — deletions excluded,
   renames resolved to the new path.
3. `git status --porcelain -z --untracked-files=all` — an agent's brand-new
   `.tsx` is invisible to step 2. Honors `.gitignore`, so `node_modules/` and
   `dist/` are excluded for free.
4. Union → filter by `isFormattable` → sort.

On main, `merge-base(HEAD, main) == HEAD`, so the set is just dirty/untracked
files. Correct: main is formatted inductively because every branch formats its
own diff before landing.

### E. `./equin format`

**Ship it — it is a prerequisite of `format-clean`, not an optional extra.**

`push` never builds: `push.ts:77` spawns `check --scope tree` in a subprocess.
Today you can edit a `.tsx`, check, and push with no build, because the other
in-sync checks only fire when you touch a codegen input. With `format-clean` and
no `format` command, any `.ts` edit not followed by a build fails at push and the
only fix is a multi-minute build (build lock + Postgres wait + DB fork + ~62
checks + vite) to correct whitespace — across 84 worktrees.

`plugins/framework/plugins/cli/bin/commands/format.ts` exporting `registerFormat`,
registered in `bin/cli.ts` alphabetically between `registerDeploy` and
`registerNormalizeGenerated`. The body is ~10 lines and must contain **zero new
logic** — a thin wrapper over the same `formatChangedSources` that `build.ts`
calls, or the policy has two implementations.

This does not weaken decision 1. That decision's content is "no writer after the
last build, because it invalidates the check cache and the artifact store." An
explicitly-invoked `format` is neither: before a build it is subsumed, after one
it is a no-op. It only ever writes bytes a build would have written.

**Do not put formatting into push's post-rebase normalize**, tempting as it is
(push already rebases, regenerates and amends, and the cache is already cold
there). It would amend reformatted *hand-written* source into a landing commit
nobody looked at. Generated artifacts may be amended silently; human code may not.

## Known breakages and risks

**`class-token-walk-in-sync` — a real, specific breakage that needs handling.**
The check asserts six `no-adhoc-*` lint rule files carry a byte-identical copy of
a shared class-token walk (duplicated on purpose: lint rules are dual-loaded
under jiti, which can't resolve `@plugins/*`). **All six are currently
non-conformant.** A branch touching one of the six formats only that one and
breaks the byte-identity. Fix: treat the six as a coupled set — when any is in
the changed set, format all six. Express it in `format/core` next to the
allowlist, referencing the check's own `EXPECTED` list.

**Prettier failures fail the build loudly.** A syntax error surfaces with
`file:line:col` — strictly better than today, where `tsc` would fail later with a
worse pointer. Do not swallow and skip: a silently-skipped file lands unformatted
and `format-clean` then fails at push with no explanation. Partial progress needs
no rollback (formatting is idempotent and per-file).

**Agent snapshot staleness is reduced, not eliminated.** A build that reformats a
file the agent just wrote still invalidates its snapshot. Three mitigations, all
cheap, all worth building in: (1) **write only on byte difference** — after a
branch's first build, subsequent builds touch 0–3 files; (2) **log what moved**
(`formatChangedSources` returns `formatted[]`) so the agent sees it in the build
output rather than as a mystery Edit failure; (3) **re-read immediately before
writing and skip if the bytes changed since the read** — the build lock
serializes builds, not the agent's editor, so an edit landing mid-pass can
otherwise be clobbered.

**Migration/snapshot checks are safe.** `snapshot-chain-intact` reads
`*_snapshot.json`, the migration checks read `.sql`/`.json` — none formattable.
`migrations-in-sync` spawns drizzle-kit over `schema.ts` files, which *are*
formatted, but drizzle derives snapshots semantically so the SQL is identical.
Note `generateMigration` runs at the top of `generateAppSources`, i.e. *before*
the format pass — harmless, but comment it so nobody "fixes" it by moving format
earlier.

**Web-artifact churn is ~zero in steady state.** The format scope *is* the
changed scope, so every plugin whose artifact formatting invalidates was already
invalidated by the edit itself — and it happens inside the same build (pass at
L995, `buildAndPublishWebDist` at L1107), never as an extra one. Write-on-difference
is what makes this true. One exception: `builderSourceDigest` hashes
`web-artifacts/core/` into the *global* identity, so a stray reformat there
invalidates the whole fleet.

**The check cache pays a one-time cost per branch** — the first build that
reformats anything changes the tree hash and re-runs all ~62 checks.

**`.gitattributes` needs no change.** `plugins/**/*.generated.ts merge=regen-generated`
still works: the driver takes upstream + drops a marker, and normalize
regenerates through `writeGenerated`, so re-derived bytes are formatted by
construction. Prettier availability on that path is guaranteed three times over —
`normalize-generated.ts:70` and `.githooks/post-rewrite` both route through
`bin/index.ts` / `./equin` (which run `ensureDeps()`), and `push.ts` runs
`bun install --frozen-lockfile` between rebase and normalize.

**Cross-worktree conflicts.** For a file only one branch touched, nothing
conflicts. For a file both a branch and main touched, the branch's side is
formatted and main's isn't → a textual conflict where there would have been a
clean merge. Expect a burst in the first week, concentrated in hot files. No
`.git-blame-ignore-revs` is needed since there is no sweep commit.

## Implementation order

**Commit 1 — primitive + lint rule. Zero behavior change.**
1. Root `package.json`: exact-pin `prettier` in `devDependencies`; regenerate
   `bun.lock`. (Verified this does not perturb web-artifacts' identity hash —
   `identity.ts` folds named packages, not the root manifest.)
2. Root `.prettierrc` with the "not read by the build" header.
3. `plugins/framework/plugins/tooling/plugins/format/` — package.json, CLAUDE.md
   (prose only), `core/index.ts`, `core/internal/prettier.ts`,
   `core/internal/changed-files.ts`.
4. `plugins/framework/plugins/tooling/plugins/lint/plugins/format-safety/` —
   `lint/index.ts`, `lint/no-adhoc-prettier.ts`, `lint/no-adhoc-prettier.test.ts`.
5. `./equin build` regenerates `lint.generated.ts` + docs; commit those.

*Gate:* `./equin check` green. Nothing formatted yet.

**Commit 2 — the funnel. Byte-neutral refactor.**
6. `codegen/core/write-generated.ts`; export from `codegen/core/index.ts`.
7. Migrate all 13 write sites.
8. `pre-barrel-manifests.ts:107` → `writeGenerated` (its
   `PreBarrelManifest.render` is already `(root) => string | Promise<string>`,
   so no signature change).
9. `pre-barrel-guard.ts` → compare against `formatGenerated(...)`. **Do not skip.**
10. Wrap the comparison in all 10 in-sync checks.

*Gate:* `./equin build && git diff --stat` produces **empty** output —
that single command proves byte-neutrality. Then `./equin check` green.

**Commit 3 — build formats changed sources.**
11. `formatChangedSources` / `listChangedFormattableFiles` / `findUnformatted`.
12. The `build.ts:995` insertion.
13. The `class-token-walk-in-sync` coupled-set handling.

*Gate:* build twice in a row; the second produces no diff. Deliberately
misformat a file, build, confirm it is rewritten and logged.

**Commit 4 — `./equin format`.**

**Commit 5 — the `format-clean` check.** Land only after commit 3 has been on
main for a push cycle, so main is provably self-consistent before the gate turns
on.

**Commit 6 — generated `*.generated.ts` formatting.** One predicate flip plus
the per-glob printWidth override; run `./equin build` and commit the 18
reformatted files **in the same commit**. Isolated last so it is revertible.

## Verification

- `./equin check` green after every commit.
- Commit 2's byte-neutrality gate: `./equin build && git diff --stat` empty.
- Idempotence: `./equin build` twice; second run reports 0 formatted.
- Negative test: misformat a `.tsx`, build, confirm rewrite + log line.
- `format-clean` negative test: misformat a file, commit it without building,
  run `./equin check format-clean` — must fail naming that file, and
  `./equin format` must fix it in seconds.
- Coupled-set test: touch one of the six `no-adhoc-*` lint files, build, confirm
  `class-token-walk-in-sync` is green (all six formatted together).
- Cache test: after a build, re-run `./equin check` — should be a cache hit,
  proving nothing wrote after the hash.

## Open decision — generated-file printWidth

Decision 6 was taken on the premise that a wide printWidth avoids the diff
blowup. **Measured, it does not.** Total lines across the 18 tracked
`*.generated.ts` (currently 2,063):

| printWidth | total lines | vs today |
|---|---|---|
| 80 | ~30,000 | ~15× |
| 160 | 28,762 | 14× |
| **200** | **24,744** | **12×** |
| 400 | 11,793 | 5.7× |
| 800 | 5,860 | 2.8× |
| 1500 | 5,125 | 2.5× |

There is no width that keeps them compact — prettier breaks the
`dependsOn: [...]` arrays regardless, and the longest current line is 1,395
chars. `web.generated.ts` alone goes 783 → 10,150 lines at default width. These
are the most frequently regenerated files in the repo and sit under the
`merge=regen-generated` driver, so every plugin add/remove produces a
correspondingly larger diff. Against that: `**/*.generated.ts` is already in
eslint's global `ignores`, the files carry `// DO NOT EDIT`, and nothing reads
them by hand.

The design is identical either way — the funnel is worth building for the
13-site dedup and single-owner property alone, and the choice is **one predicate
in `formatGenerated`**. Commit 6 exists precisely so this stays revertible.
Recommendation: exclude, or accept ~2.8× at printWidth 800 as the realistic
floor if consistency in generated output matters more than diff size.
