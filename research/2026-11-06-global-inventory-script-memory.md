# Why a blocking-fs inventory script held 2.2–3.8 GB

Task: blocking-fs inventory memory (supervisor task-1793965642-94fdhj; found by
task-1793969193 / task-1793973730, [`2026-11-06-global-host-pressure-by-owner.md`](2026-11-06-global-host-pressure-by-owner.md)).

## What the script was

Not a committed file: a scratch script (`blocking-fs/scripts/scratch-inventory.ts`,
in the worktree of the agent migrating sync fs call sites) that listed where the
new `blocking-fs/no-sync-fs` rule fires, so the 503 call sites could be fixed
or exempted. It:

1. parsed the root tsconfig;
2. built **one `ts.createProgram` over every file** (15,338 roots → 19,220
   source files with lib and `node_modules` declarations);
3. ran ESLint with the type-aware rule over the 6,184 `server|machine|central|deps|core|shared`
   files, `parserOptions.programs: [program]`.

Four ran at once while the rule was iterated on.

## Layers (live heap after `Bun.gc(true)`, program held alive)

Reproduced on this checkout with the same pattern. One process, the rules run
one after another on the same program (3,049 files in the rule's scope).

| layer | live heap | added |
| --- | --- | --- |
| program (19,223 files: parse + bind) | 1.9 GB | 1.9 GB |
| + checker created | 2.44 GB | +0.5 GB |
| + typed parse of 3,049 files (no-op rule asking for parser services) | 2.62 GB | +0.18 GB |
| + old rule: `getResolvedSignature` on every call | ~5.1 GB | **+2.5 GB** |

RSS is about 1.5–2× the live heap under bun (JSC slack, see
`2026-11-06-global-agent-ops-memory-is-gc-slack.md` in task-1793984663):
whole runs peaked at **7.2–8.5 GB** maxrss.

**Layer 1, the program (1.9 GB).** This is real data: about 100 KB of AST + symbols per
file. Rooting the program at only the 6,184 linted files does not help.
Their import closure is 15,662 files (1.4 GB live). The program only gets small
when the rest of the repo is served as `.d.ts`, which is what `type-check`'s
batches do (≤ K sources per program, stored `.d.ts` for the rest, each
batch in a fresh process under a host grant).

**Layer 2, what the rule asked (+2.5 GB), the largest.** The rule called
`checker.getResolvedSignature(call)` on every `CallExpression` to find ~150
hits. Resolving a call does overload resolution: it checks every argument,
contextually types callbacks and checks their bodies. Asked of every call,
that amounts to a full semantic check of each file, and the checker keeps every type it
computed for the life of the program.

Narrower questions, measured the same way (each added on top of the layers above):

| what the rule asks | added live | lint time (3,049 files) |
| --- | --- | --- |
| `getResolvedSignature(call)`, every call (old) | +2.5 GB | 63–181 s |
| `getTypeAtLocation(call.callee)`, every call | +1.25 GB | 25–44 s |
| member call gated by property name (`/Sync$\|^native$/`), then the callee's type (new) | **+0.37 GB** | **15 s** |

The callee's type alone is still expensive because a member callee's type
needs its receiver's, and that cascades through every initializer the
receiver reads. The name gate skips `x.map(…)`, `db.select()`… outright. An
identifier callee (an import alias, timed-fs's `typeof fs.readdirSync`
twins) is still asked, so those stay caught.

## Fix

- `blocking-fs/no-sync-fs`: gated by member property name, then the callee type's
  call-signature declarations; never `getResolvedSignature`.
- `user-path/no-sync-fs` (same shape: `calleeDeclaration` on every call in
  runtime code): the same gate and callee-type prefilter, and the call is resolved only for
  a candidate (it needs the overload's path parameters).
- The callee's type is taken non-nullable, so an optional chain on a receiver
  that may be absent (`m?.readFileSync(p)`, callee type `fn | undefined`) still
  has its signatures (found by the independent review; tested in both suites).
- Accepted gap, documented in both CLAUDE.mds: a blocking function
  re-exposed under a property not named `*Sync`/`native` (`o.read = fs.readFileSync`).
- lint `CLAUDE.md`: *A type-aware rule asks the checker the narrowest question*,
  and *Running a rule over the whole repo is `./equin check type-check`*.
- Tests: a new typed suite for `blocking-fs/no-sync-fs` (direct, namespace,
  import alias, typeof twin, `realpathSync.native`, inside a callback,
  optional call, out-of-scope, the documented gap); alias and twin cases
  added to `user-path/no-sync-fs`'s.

## Before / after

Whole-repo inventory (19,222-file program, the rule over 6,184 files), as the
scratch script did it:

| | old rule | new rule |
| --- | --- | --- |
| messages | 149 | 149 (byte-identical list) |
| live heap the rule adds | +2.5 GB | +0.37 GB |
| peak RSS (maxrss) | 7.2 / 8.5 GB (two runs) | 4.7 GB |
| lint phase | 200–300 s (loaded host) | 33 s |

`user-path/no-sync-fs` over its 6,067 runtime files: 141 messages, identical
old vs new; +0.72 GB live new vs a further +2.26 GB for the old one on top; 35 s
vs 91 s.

The ~2 GB program floor remains for any hand-built whole-repo program.
That is the reason the sanctioned path is `./equin check type-check`, not a
script.

## The same pattern elsewhere

- **Committed checks**: none hold a whole-repo program but these:
  - `type-check` (bounded by K batches, fresh process each);
  - `type-check`'s `full-check` (a fresh whole program on purpose: the daily
    backstop on main and dual mode);
  - the IDE / `eslint` CLI via `projectService` on the one project.

  Syntactic per-file scanners (`pane` checks, `data-files/roots`, the
  plugin-records facets) parse, extract and drop each file.
- **Type-aware rules**: only these two called `getResolvedSignature` per call.
  Inside `type-check`, a run where only a typed lint group is stale (an edited
  type-aware rule) lints in program 2 without re-diagnosing the files. There,
  the rule's questions are the checker work, so the gate also cuts that batch's
  CPU and heap. A run that re-checks files fills the checker anyway.
- **Scratch scripts**: the agents' `scratch-rename.ts` (a language service
  over the whole program, 7.2 GB) is the same class. A rename across the repo
  has no sanctioned bounded tool. `./equin plugin move` covers plugin paths only.
- **Runtime**: whatever is live, bun holds ~2× of it in RSS. That lever
  (TS-program processes on node) is task-1793984663's.
