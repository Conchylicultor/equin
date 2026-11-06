# The demo snapshot's address covers every module that runs while it is taken

Task: task-1793984038 (supervised by conv-1793665695-3p52r4). Track: wiki "Track: apps running in the browser" (`block-d04c6c0d-…`); design sub-page "Design: a browser host's data kept in browser storage" (`block-c0ff62ec-…`), section "A starting snapshot".

## Context

The build-time demo snapshot (8fb90a3422) was designed so "a stale snapshot cannot ship": its address hashed the worker's whole artifact closure plus the snapshot script's static closure. The next day, build pipeline step 8 (0954abe86a, `research/2026-11-06-global-build-pipeline-step8-host-snapshot-and-cold-frontend.md`) **deliberately removed all server code from the address** to stop re-takes (19 of 30 profiled builds re-took it, 7–48 s each). Its "accepted trade": after a server change that alters what the seed writes, the demo ships older data until the next migration / config / seed / npm change. The wiki design page was never updated, so it still promised the old guarantee.

### What the address covers today (`web-artifacts/core/internal/host-snapshots.ts`, `hostSnapshotDirName`)
- a layout constant and the module source the stage writes;
- `lockfileNpmResolutions(bun.lock)`;
- every non-test file of host-storage's `core/` (the codec);
- the glob files of the worker closure's artifacts (migrations, committed config);
- every non-test, non-root-doc, non-generated file of the host plugin (`demos/workspace`: seed, `bin/*.ts`, `data/`).

### Why the icon warm-up was outside it
`ui/icons/sprites/bundled-symbols`' warm-up is server code in the booted graph: no file of it is in any of the five inputs. Only the snapshot script (a host-plugin file) moved the address — which is why editing it (a size log) "fixed" it. The same holds for every job, derived table, warm-up, fixture writer's callee, or `browser-host.generated.ts` (excluded as "generated").

## Design

**The address = (what runs) + (what it reads) + (the format).** "What runs" is derived, never listed:

- **Code: the Merkle key of the snapshot script in the plugin-records module graph** (`buildModuleGraph(input, [script]).keyOf(script)`, `plugin-meta/plugin-records/core/internal/module-graph.ts`) — the same graph `serverPortabilityOf` and the browser-host codegen measure with. It follows static AND dynamic edges, so it walks `browser-host.generated.ts`'s literal `loader: () => import("@plugins/…/server")` thunks: the whole server graph the seed boots (and `bun-host.ts`'s disk swaps, the seed, host-storage's codec). Its key hashes every module's path and blob and every unresolved internal specifier. Over-approximation (a dynamic edge never taken) is the safe direction. File facts are records, so only changed modules are scanned: the build pays a walk, not a re-read.
  - The graph throws/marks unresolved specifiers; an import resolving to no file is in the key (a file appearing moves it).
- **Data the take reads off disk:** the bundled glob files (unchanged), and the host plugin's non-code files (`data/` — kept by the existing seed loop, narrowed to non-module files since modules are now covered by the key).
- **Runtime + npm:** `lockfileNpmResolutions` (PGlite, the iconify set, every npm package the graph runs) and `Bun.version` (the runtime executing the take; rare).
- **Dropped as now redundant:** the separate host-storage `core/` loop (the codec is in the script's closure), the `format` constant stays only as `SNAPSHOT_LAYOUT`.

Portable server code cannot read the disk (that is what portability means, enforced by the boundary derivation), so the only off-disk reads during a take are the Bun swaps (migrations, config, `data/`) — all covered.

### Pipeline
`hostSnapshotDirName` becomes graph-aware: it takes the repo snapshot and calls `buildModuleGraph({ snapshot: repo, store: currentRecordStore(), readOutside: () => null }, [script])`. Called from `pipeline.ts` (stage 4a) and `expected.ts` (`map-in-sync`) — same derivation, cannot drift. The repo snapshot is taken after codegen, so `browser-host.generated.ts` is addressed by what it holds.

### Tests (`host-snapshots.test.ts`)
- NEW: a server module reached only through the generated listing's dynamic `import()` (not imported by the script) → address moves. (The issue's required test.)
- NEW: a module the seed's callee imports statically → moves.
- Existing: migration, seed file, data file, npm resolution → move; a workspace entry, tests, root docs, nested plugin, an unrelated server module (outside the closure) → don't.
- Flip: "server code does not move it" becomes "server code outside the graph does not".

## Outcome (2026-11-06)

Implemented as designed, plus three review hardenings: every file of the host's `data/` is hashed whatever its extension (a prototype's `.ts` is data read as bytes); `patches/` is hashed (bun.lock names a patch by path only, so editing one moved nothing); an import in the take's graph that resolves to no file throws (the key could not see that code). Proof on the real tree: editing `ui/icons/sprites/bundled-symbols/server/internal/drawer.ts` (the warm-up, not imported by the script) moves the code key `3bc349…` → `e3e867…`, and back on revert.

### Measured
| | data-only address (step 8) | this change |
| --- | --- | --- |
| What the take's code covers | the host plugin's files + host-storage `core/` | 2,570 modules, ~460 plugin dirs (the script's whole graph, dynamic edges included) |
| main commits that re-take, last 7 days (398 first-parent commits; npm changes left out of both) | 42 (~6 a day) | 176 (~25 a day, 44 % of commits) |
| Address cost per build, nothing changed (`artifacts:host-snapshots`) | ~0.01 s | 0.07 s (module-graph facts are records shared with codegen) |
| Address cost, empty record store (cold) | — | ~3.9 s (scans 2,570 files; only a fresh store pays it) |
| One take when the address moved (this worktree, loaded host) | 7–13 s quiet / up to 48 s loaded | 28.4 s: graph 21.2 s (change-feed trigger install 13.5 s, database 6.0 s), seed 2.5 s |

Agent worktrees: a build after an edit to any module in the take's graph re-takes (one take per build that changes it; a build with no change reuses it). That is the 7–48 s per build step 8 removed, back for server edits inside the graph, and the price of a snapshot that cannot be stale.

The structural fix for that cost is a cheaper take, not a narrower address: ~60–75 % of a take is installing change-feed's triggers and running the migrations on a fresh database (task-1793932779-i11s7u, still open), not the seed (~1–2.5 s).

## Follow-up (not this slice)
Making a take cheap is the structural answer to frequent re-takes: task-1793932779-i11s7u (change-feed install), then the 384-migration replay on a fresh database.

## Verification
- `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`
- `./equin build` (takes a snapshot at the new address); demo e2e: `apps/demo/e2e/snapshot.ts` first, then persistence, no-leak, app-switch, places-in-demo.
- Edit a server body in the graph not imported by the script → `./equin check map-in-sync`-style address moves (observed in the next build: re-take logged).
- Independent sonnet review of `git diff $(git merge-base HEAD main)`.
