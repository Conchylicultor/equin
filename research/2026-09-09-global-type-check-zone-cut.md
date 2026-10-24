# type-check: the zone cut, measured — and why zone-level projects do not pay here

**Date:** 2026-09-09
**Category:** global (checks infra; affects build, push and the host queue)
**Status:** proposed — decision needed (see "What to decide")
**Sidequest:** A.3 on the "Build, check, …" page (`block-f0d24b10-d743-409d-bbc1-844ed27db026`),
claimed by `att-1788960115-8hvc`. Continues
`research/2026-09-08-global-type-check-per-target-program-skip.md`.

## The question

A.3 proposed cutting the 1,035 plugins into layered *zones*, one TypeScript project per zone × runtime,
wired with project references so that "each file is checked once and an edit re-checks only the zones
downstream of it". The owner asked for the zone cut to be proposed before anything is built. This
document is that proposal — except that the measurement reverses the premise, so the proposal is to
**not** build A.3 and to take the two levers the data does support.

Everything below is measured on this worktree's tree on 2026-09-09: the same import graph the
type-check builds (`check/import-graph.ts`), the same 30-day commit sample the previous note used
(274 commits on main, `commits-30d.txt`), TypeScript 6.0.3, this host (18 cores, 64 GB). The
analysis scripts are at `.check-scratch/` in this worktree (gitignored; see "Files").

## How the graph was modelled

A zone yields up to four projects: `<zone>.core` (`core/` + `data-dirs/` + plugin-root files),
`<zone>.web` (`web/` + `shared/`), `<zone>.server` (`server/` + `shared/`), `<zone>.central`, plus
`<zone>.test` (that zone's `*.test.ts`, `__tests__/`, `e2e/`). `shared/` is counted in both web and
server, exactly as today's programs duplicate it. Edges follow the runtime-isolation rows of
`boundary-config.ts`. `data-dirs` sits in the core project because it is directly above `core` in
those rows and is node-only like `paths/core` — and because two plugins import their own
`data-dirs/` from `core/` (`database/core/internal/config.ts`, `signal-origin/…/sink/core`), which
the boundary check does not see (it polices the cross-plugin alias form only, as its own comment
says) and which would otherwise be a core↔server project cycle.

Cost model, per re-run project: own source files + 0.35 × the upstream `.d.ts` files it loads +
the `node_modules` declaration set of its runtime class (web 2,683 files, node 1,545, test 2,972 —
the counts from Finding 2 of the previous note). "Today" is the seven programs as they exist:
39,997 file-checks per miss. The one constant that matters — that a project pays a fixed cost for its
type environment — was verified directly:

| one-file project | files loaded | CPU (user) |
| --- | --- | --- |
| web (`lib.dom` + react types) | 68 | 3.1–3.2 s |
| node (`@types/bun`) | 220 | 4.2–4.5 s |

So every project that runs costs 3–5 CPU-s before it looks at a single source file, and the real web
project loads 2,683 declaration files, not 68.

## Finding 1 — the plugin graph is a DAG per runtime; no folder cut is

At plugin × runtime granularity (1,653 projects) the graph has **zero cycles** — the
`plugin-boundaries` R6 check holds. Every coarser cut along the folder tree cycles:

| cut | zones | projects | cycles |
| --- | --- | --- | --- |
| top-level folder (`primitives`, `infra`, …) | 34 | 98 | 3 — a 9-group core cycle, an 11-group server cycle, a **27-group web cycle** |
| depth-2 (`primitives/css`, `infra/jobs`, …) | 423 | 844 | 6 |
| depth-2, then split every cyclic group one level deeper until acyclic | 611 | 1,093 | 0 |
| top-level, refined the same way | 603 | 1,078 | 0 |

The edges that close the cycles are not mistakes to fix; they are the codebase's actual shape. Every
umbrella holds both foundation and feature plugins: `primitives/launch` is an agent-manager widget
(imports conversations); `infra/claude-cli` imports `conversations/model-provider`; `database/query`
is an MCP tool that imports `tasks-core`; `primitives/css/layout-harness` is a debug app;
`infra/jobs/deadline-audit` imports `reports` which imports `shell/notifications` which imports
`database/live-state-snapshot` which imports `infra/jobs`; `plugin-meta/plugin-view` is Studio UI;
`ui/tokens` register into the Settings app's theme customizer. A cut needs ~600 zones before the
folder tree stops lying about layering.

A semantic cut was tried anyway: a ranked zone list (foundation < infra < primitives < platform <
pages / agent-manager < one zone per app < glue < tooling) with each plugin *lifted* to the zone of
its highest-ranked dependency, which yields a DAG by construction and lists every re-home. The best
order found lifts **569 of 1,035 plugins** out of their declared zone (`lift-o2.out`). The folder
tree encodes ownership, not layers.

## Finding 2 — where the edits land: two thirds of commits touch the bottom layer

Depth bands are the one cut that is a DAG with no exceptions (zone = band of longest-path depth in
the plugin DAG; every edge goes strictly down). With four bands balanced by file mass, for the 257
commits that changed TypeScript:

| lowest band a commit touches | commits |
| --- | --- |
| L00 (foundation band: `page/editor`, `data-view`, `config_v2`, `ui-kit`, `live-state`, `pane`, `infra/jobs`, …) | **167 (65%)** |
| L01 | 9 |
| L02 | 10 |
| L03 (apps, conversations, tasks) | 10 |
| only non-runtime folders (`check/`, `lint/`, `scripts/`) | 61 |

Bands touched per commit: 1 band 68, 2 bands 69, 3 bands 47, 4+ bands 73. The most-edited code IS
the foundation (the previous note's "79% touch framework/ or primitives/", seen from the DAG side).
Any layering re-runs everything above the bottom band on two commits in three.

## Finding 3 — the modelled cost of every cut, against today and against A.5

Per commit, share of today's 39,997 file-equivalents (100%). A.5 is the per-program skip that shipped
(uncommitted) from `att-1788944218-aj1a`.

| cut | projects | modelled cost, median | mean | cold, everything |
| --- | --- | --- | --- | --- |
| today (7 programs) | 7 | 100% | 100% | 100% |
| A.5 per-program skip | 7 | 97% | 84% | 100% |
| 3 depth bands | 14 | **62%** | 64% | 82% |
| 4 depth bands | 19 | 70% | 79% | 104% |
| 5 depth bands | 24 | 87% | 96% | 127% |
| 6 depth bands | 27 | 98% | 108% | 140% |
| 8 depth bands | 35 | 127% | 128% | 176% |
| semantic zones with lift (23 zones) | 64 | 81% | 127% | 304% |
| one project per plugin | 1,653 | — | — | — (fixed cost alone ≈ 8,000 CPU-s) |

The curve is monotone: every zone beyond three costs more in fixed type-environment loads than it
saves in skipped source. The ceiling of the whole approach is about **1.6× on the median commit**, at
three bands, with three bands named `L00/L01/L02` and their membership regenerated from the import
graph on every build.

And the raw file-slot number that A.3 was reasoning from — "an edit re-checks only the median 10%
of files downstream" — is only true inside a program, where tsc's own incremental builder already
does it. Across projects the same edit still re-runs a median **58%** of file-slots at any band
count, because of Finding 2.

## Finding 4 — the same 1.6× is available with no zone machinery at all

Merging the five node-side programs (`server-core`, `central-core`, `cli`, `tooling`, `tools` —
near-copies of one another, the previous note's Finding 5) into one program of 3,823 repo files:

| layout | file-checks per miss | modelled vs today |
| --- | --- | --- |
| today: 7 programs | 39,997 | 100% |
| 3 programs: web-core, node (merged), test | ≈ 25,000 | **≈ 63%** |

That is the three-band number, with three programs instead of fourteen projects, no declaration
emit, no generated tsconfigs, no membership churn, and it composes with A.5's per-program skip (three
keys instead of seven, each hit more often because a server-side edit no longer invalidates five keys).
It is A.4 on the page, and it is not a fallback — it is the layout lever.

## Finding 5 — the remaining cost is check work, and signatures are the lever for it

Zones and program layout only move the *parse* floor. The check work — which files tsc re-checks
after an edit — is decided inside a program by per-file **signatures** in the `.tsbuildinfo`, and the
previous note found that today's `noEmit` worker stores a real signature for only 54–143 of ~6,400
files (the rest are the `signature = version` placeholder). Without real signatures tsc cannot tell a
body edit from an API change, so any edit to a hub re-checks its whole importer closure — the
"hub edit costs the same as cold" result. The lever is to compute signatures, which declaration
emit does; the previous agent's `worker-decl.ts` emits declarations to a no-op writer so only the
buildinfo reaches disk. Measured on the `web-core` program (9,158 files), CPU = user + system of the
worker process, same tree, fresh buildinfo per variant, hub = `web-sdk/core/deferred-load-store.ts`
(its barrel has 1,026 direct importers):

| run | today's `noEmit` worker | declaration-emit worker |
| --- | --- | --- |
| cold, no buildinfo | 193 CPU-s, 8.1 GB, real signatures 0 | 159 CPU-s, 10.0 GB, real signatures **6,210** |
| identical tree | 48 CPU-s, 2.4 GB | 38 CPU-s, 2.5 GB |
| **body-only edit in the hub** (`void 0;` inside a function) | **168 CPU-s, 7.8 GB** | **38 CPU-s, 2.5 GB** |
| revert | 44 CPU-s | 38 CPU-s |
| API edit in the hub (a new export) | 152 CPU-s, 8.1 GB | 195 CPU-s, 9.5 GB |
| revert | 165 CPU-s | 183 CPU-s |

A body-only hub edit drops from a near-cold rebuild to the identical-tree floor: **4.4× less CPU
and 3× less peak RAM**, on a run that today is the dominant cost. An API edit still costs cold in
both worlds, correctly — its importers really must be re-checked. The cold run is not slower for
computing 6,210 signatures (159 vs 193 CPU-s; the difference is host load, the buildinfo grows
2.6 → 3.1 MB). It also fixes the warm-base pool: a sibling's base with real signatures makes a fresh
worktree's first run cost the delta rather than cold (the previous note's 86 s ≈ cold result was a
base with 55 real signatures).

The one thing this does not measure is what share of real commits are body-only. It does not have
to be estimated: once the worker emits signatures, the transcript's per-worker CPU line answers it
over a week.

Gate before flipping: `emitDeclarationOnly` with `rootDir` = repo root was clean on `web-core` and
`server-core` (2026-09-09, previous agent); the remaining five targets need the same dry run, and
any `TS2742` ("inferred type cannot be named") it surfaces is a real annotation to add, not a reason
to skip the target.

## What to decide

1. **Retire A.3.** Zone-level projects cannot beat ~1.6× here and would cost a new orchestrator,
   generated tsconfigs per zone × runtime, declaration emit to per-project out dirs, and a zone
   membership that is either derived (and churns) or declared (and needs ~600 re-homes). The zone
   *question* on the page ("define the zone graph, refactor to make it a DAG") is a real
   architecture question, but it is not a type-check lever and should not be justified by one.
2. **Do A.4 now:** one node-side program. One tsconfig, one target discovery change, the ownership
   pass unchanged. Verified by the same instrument as A.5: CPU seconds per worker in the transcript.
3. **Then the signature lever** (Finding 5), which the experiment confirmed: the worker emits
   declarations to a throwaway writer so the buildinfo carries real signatures, and a body-only
   edit in a hub file stops re-checking its thousand importers (4.4× less CPU, 3× less RAM on the
   measured case). Ordered after A.4 only because A.4 is smaller; the two are independent and the
   signature lever is the larger win.

## As built — the signature lever, 2026-09-10 (`att-1788960115-8hvc`)

Decision taken on this document's "What to decide": A.3 retired, the signature lever built first
(this worktree), A.4 not yet.

**The change.** `shared/worker.ts` now emits declarations through a writer that keeps only the
`.tsbuildinfo` — `noEmit: false`, `declaration`, `emitDeclarationOnly`, `rootDir` = repo root, an
`outDir` that is named and never written — and reads the declaration-diagnostics channel and the
emit result's diagnostics as errors. Nothing else in the check changed; A.5's program key reads only
the buildinfo's file list and is unaffected, except that the worker's own source changed, which
invalidated every recorded pass exactly once.

**The gate, and what it found.** The earlier "0 errors on web-core and server-core" clearance
(A.2) was blind: the worker variant it used collected the builder's semantic diagnostics but not
`getDeclarationDiagnostics()` or the emit result's diagnostics, which is the only channel that
carries "inferred type cannot be named" (TS2883) and "exported variable uses a name that cannot be
named" (TS4023 / TS4082). Read correctly, all seven targets had errors, from exactly seven source
sites — every one an exported value whose type TypeScript could not write down:

| site | error | fix |
| --- | --- | --- |
| `resource-runtime/core/runtime.ts` (`WsHandler`, `WsData`) | TS4023 via server-core and central-core `resources.ts` | export the interfaces, and from the barrel |
| `fields/server-capabilities/server/internal/storage.ts` (`FieldStorageToken`) | TS4023 via `Fields` | export the interface |
| `apps/sonata/plugins/shell/web/slots.ts` (`SonataSectionArea`) | TS4082 on the plugin's default export | export the interface |
| `promise-safety/lint/no-floating-promises.ts` | TS2883, five internal names | annotate as `TSESLint.RuleModule<string, unknown[]>` |
| `promise-safety/lint/index.ts` | TS2883 (through the rule above) | fixed by the rule's annotation |
| `eslint.config.ts` | TS2883 (`RulesConfig` from `@eslint/core`) | annotate as `Linter.Config[]` |

One more surfaced only through the annotation: the root resolved `@typescript-eslint/utils` and
`parser` at 8.59.1 (spec `^8.20.0`) while the plugin bundled its own utils at 8.59.2, so the rule's
type and the annotation's type came from two copies and were not assignable to each other (a
`#private` member in scope-manager). The three packages are meant to move as one set; they are now
pinned to one exact version (8.59.2), and the lock no longer carries a second copy.

**Verified.** `./equin build` green with the new worker (full suite). Every target's buildinfo
now carries a real signature for every repo file (web-core 6,219 of 9,172 entries — the remainder are
`node_modules` declarations, which get none). Then the paired experiment, this time on the SHIPPED
worker, single worker, no queue, on the same hub file as Finding 5:

| run (web-core, shipped worker) | CPU | peak RSS |
| --- | --- | --- |
| cold | 241 s (host load 20) | 6.6 GB |
| identical tree | 42 s | 2.4 GB |
| **body-only edit in the hub** | **40 s** | **2.4 GB** |
| revert | 36 s | 1.9 GB |
| API edit in the hub (new export) | 197 s | 7.4 GB |
| revert | 278 s (load 18) | 4.2 GB |

The body-only edit now costs the identical-tree floor; the API edit still costs a near-cold rebuild,
as it must. Unit tests of the type-check plugin: 21 pass.

**A measurement trap, recorded so nobody repeats it.** A first attempt to show the same thing
through `./equin check` was contaminated: my tool wrapper was killed but the demo script it
had started was not, so two scripts edited the same hub file while each check waited 15–40 minutes
for a host grant and read the tree only when it finally ran. The per-run lines in those logs
describe each other's trees. Through-the-check numbers are also six demoted workers on a loaded
box, whose CPU seconds are not comparable to a single worker's. The direct worker run is the
instrument; the check run only shows the deployed worker behaves the same (it does: the buildinfo
signature counts above are from the build's own workers).

**What to watch next.** The per-worker CPU line in every transcript. Over a week, on runs that are
not skipped by A.5, the share of workers at the near-cold price should fall and the median worker
CPU should move toward the identical-tree floor. That number is the honest measure of how many
real commits are body-only, which this document could not estimate.

## Files

- `.check-scratch/zone-analysis2.ts` — the project-graph model: cuts (`plugin`, `top`, `depth2`,
  `refined`, `refined-top`, `band3…12`, `hand` via `HAND_CUT=<json>`, `lift` via `LIFT_CUT=<json>`),
  cycle listing with example file edges, per-commit cost model, `--members`, `--dump-cut`.
  Outputs beside it: `*.out`, `cut-band*.json`, `project-graph.json`, `lift-o1.json`/`lift-o2.json`.
- `.check-scratch/layering.py` — depth-2 group layering of the fine DAG (`layering.out`).
- `.check-scratch/spike/` — the one-file fixed-cost projects.
- `.check-scratch/sig-exp.ts` + `worker-decl.ts` — the signature experiment (Finding 5).
- Inputs: `/tmp/att-1788884187-ak4l-scratch/scratch/{commits-30d.txt,program-lists.json}` from the
  previous agent.

`.check-*/` is the one gitignored place inside a worktree that type-check's file walk also skips, so
these scripts can live there without failing the coverage gate; they are not committed, for the
same reason the previous agent's were not (a `.ts` anywhere outside a tsconfig include fails the
gate). Committing them under `type-check/scripts/` means bringing them to lint standard first.
