# Phase 3 reversal: drop the two backstop lints, migrate the one real corpus scan

**Category:** global (framework tooling + apps/sonata) · **Date:** 2026-07-10 · **Status:** Plan

Supersedes **Phase 3** of [`2026-07-08-global-bounding-boot-time-work.md`](./2026-07-08-global-bounding-boot-time-work.md).

## Context

The boot-time plan's Phase 3 proposed two backstop ESLint rules:

- `no-heavy-onready` — flag `readdirSync`/`readFileSync` or an unbounded `db.select().from(x)` inside an `onReady`/`onReadyBlocking` body.
- `no-adhoc-corpus-scan` — flag a `readdir` + `readFile` loop in `*/server/**` outside `defineCorpusIndex`.

Both primitives (`infra/warmup`, `infra/corpus-index`) landed in Phases 0–2, so the exemption anchors now exist and the lints were the last sequenced step. Before building them we measured what each would actually catch. **Neither rule earns its keep**, and the measurement surfaced the one file in the repo that genuinely belongs on `defineCorpusIndex`. This plan records the reversal and does that migration instead.

### Evidence 1 — `no-heavy-onready` polices an empty set and misses its motivating bug

A full trace of all **33** `onReady`/`onReadyBlocking` hooks across 30 server plugins:

| Distance from hook body to a heavy shape | Count |
|---|---|
| **0 hops (lexically inline)** — what the rule detects | **0** |
| 1 hop | 1 — `release` → `reconcileOrphanPreviews` (`readdirSync` over `/tmp/sgp-*` preview dirs; correct, bounded cleanup) |
| 2+ hops | 32 |

Every `onReady` body in the repo is a thin delegator (`startPoller()`, `await ensureSystemMeta()`). The rule would ship green against zero violations and stay green.

Worse, it **cannot catch the incident that motivated the entire plan.** The `stats/cost` 3–10s event-loop freeze was:

```ts
onReady: () => { prewarmBundle(); }   // → loadBundle() → walkPerSession() → await readdir(...)
```

Three hops deep, and **async** `readdir` — not `readdirSync`. The specced rule sees nothing.

Extending it to transitive call-graph reachability is technically possible (rules here have full TS type info; `button-safety` already uses `ESLintUtils.getParserServices`), but reachability over-approximates badly. It fires on `config_v2`'s `onReadyBlocking` → `initRegistry` → `discoverScopeIds` → `readdirSync` (required, must run before serving), `conversations`' `onReady` → `startPoller` → initial `tick()`, `database`'s → `runMigrations` → `listMigrationFiles`, `reports`' → `flushBufferedReports` → `readAndClearBuffer`, and more — all correct. Callback boundaries (`setInterval`, `watchConfig`, job `enqueue`) mean reachability ≠ executed-at-boot, so the depth/callback heuristics needed to suppress those are exactly where such a rule silently goes wrong.

The **boot-budget monitor** (`plugins/debug/plugins/boot-budget/`, shipped in Phase 0) already catches this class at runtime, per-phase, regardless of hop depth or code shape, and files a deduped report + investigation task. It is the correct enforcement mechanism, and it is already load-bearing.

### Evidence 2 — `no-adhoc-corpus-scan` has the wrong discriminator

Classifying all 21 `readdir` sites under `plugins/**/server/**`, the specced `readdir` + `readFile`-loop shape fires on **5 sites, all false positives**:

| Site | Why it's absurd to route through `defineCorpusIndex` |
|---|---|
| `database/migrations/.../runner.ts` | 40 committed `.sql` files; must re-run every boot; applied-state truth is a DB ledger, not a file fingerprint |
| `debug/health-monitor/.../read-health-files.ts` | tail-reads continuously-appended logs — an `(mtime,size)` cache can *never* hit |
| `primitives/log-channels/.../persist.ts` | same: append-only channel tails |
| `infra/worktree/.../worktree-op.ts` | ≤3 ephemeral marker files |
| `apps/prototypes/files/.../list.ts` | a dozen dev-authored `meta.json` files |

And it **misses the only true positive**, because that scan is listing-only (no per-entry `readFile`):

- `apps/sonata/.../midi/plugins/folders/server/internal/reconcile.ts` — `readdir(dir, { recursive: true })` over an **arbitrary, user-configured, unbounded folder tree**, run at boot and on every config change.

The property that makes a scan dangerous is an **unbounded root**, not "reads file contents" — and unboundedness is a property of the *path*, not statically decidable from the code. A rule whose allowlist is 100% of its firings is not detecting its class.

### Decision

Do not build either rule. Runtime enforcement (boot-budget monitor) stays the guarantee. Instead, spend the effort on the one scan the measurement identified: **migrate the Sonata MIDI watched-folder reconcile onto `defineCorpusIndex`.**

---

## Design

### The current shape

`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/server/internal/reconcile.ts`:

```ts
export async function reconcile(): Promise<void> {
  const dirs = await watchedDirs();
  const onDisk = new Set<string>();
  for (const dir of dirs) {
    const files = await listMidiFiles(dir);        // readdir(recursive: true), unthrottled
    for (const path of files) {
      onDisk.add(path);
      const existing = await getSongMidiBySourcePath(path);   // ← one DB round-trip PER FILE
      if (!existing || existing.sourceMissing) await importMidiFileJob.enqueue({ sourcePath: path });
    }
  }
  const songs = await listFolderImportedSongs();   // already loads the whole set
  /* …reverse drift… */
}
```

Three problems, in cost order:

1. **N+1 sequential DB queries.** One `getSongMidiBySourcePath` round-trip per MIDI file, in a sequential loop, at boot. For a large library this dwarfs the walk. `listFolderImportedSongs()` — already called ten lines later, and already returning exactly `{songId, sourcePath, sourceMissing}[]` — makes this a single query plus an in-memory `Map`.
2. **Unthrottled recursive walk**, on the serving event loop, reached from `onReady`. No heavy-read slot, no yields, no bounded stat concurrency.
3. **A real drift hole**: a file *edited while the backend was down* is never re-imported. The live watcher catches edits; boot reconcile only enqueues when `!existing || sourceMissing`. Nothing compares content/mtime.

`defineCorpusIndex` fixes (2) directly and gives us the persisted `(mtimeMs, size)` fingerprints that fix (3). (1) is a straight rewrite we do in the same pass.

### Primitive additions (`plugins/infra/plugins/corpus-index/server/internal/corpus-index.ts`)

Three additive changes; `stats/cost` (the only existing consumer) needs no edit.

**a) `parse` becomes optional.** Sonata has no per-file payload to cache — it needs the *incrementally-maintained, throttled, fingerprint-keyed enumeration*, which is the primitive's real core; `parse` is an optional per-file payload on top. Rather than force a degenerate `parse: async () => null` at the call site, make it optional via an overload:

```ts
export function defineCorpusIndex(spec: Omit<CorpusIndexSpec<null>, "parse">): CorpusIndex<null>;
export function defineCorpusIndex<T>(spec: CorpusIndexSpec<T>): CorpusIndex<T>;
```

**b) `ensureFresh()` returns its delta.** `refreshCorpus` already computes the sets internally (`toParse`, and the dropped-key loop); today it discards them. Thread them out — this is what closes drift hole (3):

```ts
ensureFresh(): Promise<{ addedPaths: string[]; modifiedPaths: string[]; removedPaths: string[] }>;
```

> **Correction (found during runtime verification, 2026-07-10).** This section originally specced a single `changedPaths` conflating "no prior index entry" with "fingerprint differs". That is a **bug**, and it shipped briefly: because this index is `scope: "host"`, a worktree backend never persists it (`computePersist("host", isMain()=false) === false`), so its in-memory index is **cold on every boot** and *every* file lands in `changedPaths`. The deployed warm-up duly re-imported all 19 MIDI files and created 19 fresh attachment rows on a single boot — the exact N×-boot-work class this plan exists to eliminate.
>
> "No prior fingerprint" means **unknown**, not **edited**. The delta is therefore three arrays, and only `modifiedPaths` (a prior entry existed, `(mtimeMs,size)` differs) may drive re-work. `addedPaths` must never trigger work; the consumer's own store answers "is this new?". Both suites carry a regression test for the cold-index case.

**c) `markDirty(): void` added to `CorpusIndex`.**

> **This is load-bearing, not convenience.** `ensureFresh` short-circuits on `if (!dirty && env.isMain()) return;`. The `dirty` flag is only ever re-set by `startWatcher()`'s `onChange`. Sonata must **not** call `startWatcher()` — it already runs its own `@parcel/watcher` over the same dirs (mounting a second one would double-watch), and `startWatcher` is `isMain()`-gated besides. Without `markDirty()`, the second and every subsequent `reconcile()` **on the main backend** would silently reuse a stale index. `markDirty()` is the seam that lets a consumer own its watcher and still drive the index.

### Sonata `folders` plugin changes

**`reconcile.ts`**

```ts
const midiIndex = defineCorpusIndex({
  name: "sonata.midi-folders",
  roots: watchedDirsSync,                                   // () => string[]
  match: (p) => MIDI_EXTENSIONS.has(extname(p).toLowerCase()),
  indexPath: join(SINGULARITY_DIR, "sonata", "midi-folders-index.json"),
  scope: "host",
  version: 1,
});
```

`scope: "host"` is the correct split, and mirrors `stats/cost`: **the file corpus is host-global** (a user folder on the host), so one shared index lives under `~/.singularity/` and only main persists it. **The DB is per-worktree**, so the *reconcile* still runs on every backend, reading the shared index and computing any delta in memory. This also avoids a regression: with a per-worktree index file, every freshly-forked worktree would start with an empty index, see every file as "changed", and enqueue an import job per MIDI file.

`roots` is a **sync** `() => string[]`, so `watchedDirs()` becomes `watchedDirsSync()` using `realpathSync` (same ENOENT-tolerant fallback to the literal path). The canonical-path invariant that keeps `source_path` a single idempotency key is preserved: `enumerate()` builds paths by `join(dir, name)` from the realpath'd roots.

`reconcile()` becomes:

```ts
export async function reconcile(): Promise<void> {
  midiIndex.markDirty();
  const { modifiedPaths } = await midiIndex.ensureFresh();  // NOT addedPaths — see the correction above
  const modified = new Set(modifiedPaths);

  const songs = await listFolderImportedSongs();            // ONE query, not N
  const byPath = new Map(songs.map((s) => [s.sourcePath, s]));

  for (const path of midiIndex.entries().keys()) {
    const song = byPath.get(path);
    // `modified.has(path)` is new: an edit made while the backend was down.
    if (!song || song.sourceMissing || modified.has(path)) {
      await importMidiFileJob.enqueue({ sourcePath: path });
    }
  }
  // Reverse drift: a folder-managed song whose file vanished, still under a watched dir.
  for (const song of songs) { /* …unchanged, using removedPaths ∪ absent-from-index… */ }
}
```

`importMidiFileJob` already dedups by `sourcePath` and `importMidiSong` already reuses `existingSongId`, so a redundant enqueue is idempotent.

**`watcher.ts` + `server/index.ts` — get the walk out of `onReady`.**

Today `onReady → startMidiFolderWatcher() → watchConfig(…) → reconfigure() → await reconcile()`. Split cheap wiring from heavy repair:

- `reconfigure()` gains a `{ reconcile: boolean }` option. `watchConfig` fires its callback immediately at registration; that first call **mounts the watcher only**. Later (genuine config-change) calls still reconcile inline — user-initiated, not boot work.
- The initial reconcile becomes a declared warm-up, mounted like `stats/cost` mounts `costUsageWarmup`:

```ts
// server/internal/reconcile.ts
export const midiFoldersWarmup = defineWarmup({
  name: "sonata.midi-folders.reconcile",
  scope: "worktree",       // writes this backend's own DB
  run: reconcile,
});

// server/index.ts
register: [importMidiFileJob, midiFoldersWarmup],
onReady: async () => { await startMidiFolderWatcher(); },   // now cheap: mount only
```

`scope: "worktree"` preserves today's behavior exactly (every backend reconciles its own DB). Warm-up throw-tolerance is correct here: reconcile is *drift repair*, not a correctness dependency — the live watcher covers ongoing changes and the next `reconcile()` re-runs `ensureFresh()`.

> **Follow-up, not in scope:** the recursive walk still runs once per worktree backend. Gating the whole watched-folder feature to `isMain()` would kill that N× redundancy (worktree DBs are forks of main, and agents don't use Sonata), but it is a user-visible behavior change and needs an explicit call.

### Accepted behavior change

`corpus-index`'s `enumerate()` recurses on `isDirectory()` and pushes any other matching entry; today's code filters on `e.isFile()`. A **symlinked `.mid` file** inside a watched folder therefore starts being indexed and imported. This is a widening, and arguably the correct behavior. Symlinked *directories* are still not followed (same as `readdir({recursive:true})`), so the walk cannot loop.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/corpus-index/server/internal/corpus-index.ts` | optional `parse` overload; `ensureFresh` returns `{addedPaths, modifiedPaths, removedPaths}`; add `markDirty()` |
| `plugins/infra/plugins/corpus-index/server/index.ts` | no export change (types flow through) |
| `plugins/infra/plugins/corpus-index/CLAUDE.md` | document `markDirty()` + the own-your-watcher pattern; document enumerate-only (no `parse`) usage |
| `…/sonata/…/midi/plugins/folders/server/internal/reconcile.ts` | `defineCorpusIndex`; `watchedDirsSync`; N+1 → one query; `midiFoldersWarmup` |
| `…/midi/plugins/folders/server/internal/watcher.ts` | `reconfigure({ reconcile })`; drop boot-path reconcile |
| `…/midi/plugins/folders/server/index.ts` | `register: [importMidiFileJob, midiFoldersWarmup]`; `onReady` mounts watcher only |
| `…/midi/plugins/folders/CLAUDE.md` | describe the index + warm-up |
| `research/2026-07-08-global-bounding-boot-time-work.md` | mark Phase 3 superseded, link here |

Reuse (do not re-implement): `listFolderImportedSongs`, `getSongMidiBySourcePath`, `setSourceMissing`, `importMidiSong` (`…/midi/server`); `defineWarmup` (`@plugins/infra/plugins/warmup/server`); `withHeavyReadSlot`, `isMain`, `createFileWatcher` (already inside `corpus-index`); `SINGULARITY_DIR` (`@plugins/infra/plugins/paths/core`).

## Verification

Tests (`bun test`, co-located — the primitive already has 13):

1. `corpus-index`: `markDirty()` forces a re-walk on main after a clean `ensureFresh()` (the dirty-latch regression this migration exists to avoid).
2. `corpus-index`: `ensureFresh()` returns a new file in `addedPaths`, a touched file (mtime bump) in `modifiedPaths`, an unlinked one in `removedPaths`, all empty when nothing moved — and a **cold index reports every file as `added`, never `modified`** (the regression test).
3. `corpus-index`: `defineCorpusIndex` with no `parse` type-checks and yields `CorpusIndex<null>`; `stats/cost`'s existing 13 tests still pass unchanged.
4. `folders/reconcile`: with a stub index + stub DB, exactly one `listFolderImportedSongs()` call happens for N on-disk files (the N+1 kill), and enqueue fires for new / `sourceMissing` / fingerprint-changed paths only.

End-to-end, on the deployed worktree (`./equin build`, then `http://<worktree>.localhost:9000`):

5. Point the `midi-folders` config at a temp dir with a few `.mid` files. Confirm via `query_db` that `sonata_songs_ext_midi` gains one row per file, and that the Sonata library renders them.
6. **Drift hole closed:** stop the backend, edit one `.mid`'s bytes, rebuild. Confirm exactly that one file re-imports (it lands in `modifiedPaths`) and the others do not.
6b. **No mass re-import:** on a plain restart with no file changes, confirm `attachments` gains ZERO rows (the cold-index regression).
7. **Boot deferral:** open Debug → Profiling (Gantt) and confirm a `warmup:sonata.midi-folders.reconcile` span runs **after** `after-onAllReady`, and that no `readdir` cost remains inside the `onReady:apps/sonata/…/folders` hook span.
8. **No budget trip:** confirm Debug → Reports files no `boot-budget` report for the folders plugin on a cold boot with a populated folder.
9. Delete a `.mid` while running; confirm the "source deleted" badge appears (live watcher path, unchanged).
10. `./equin check` green (in particular `plugins-doc-in-sync` after the CLAUDE.md edits).
