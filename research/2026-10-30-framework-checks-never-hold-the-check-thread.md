# Checks never hold the check thread with per-file synchronous work

Task: under the slow-op notification audit (task-1793313534-w54p8d). Follows
`2026-10-30-framework-check-stall-reports-held-not-late.md`, which made
`check-thread-stall` file only on time code really *held* the thread.

## Context

Since the held-time fix, what still files on every build (main, 2026-10-30) is real:

| report (count) | held | what holds it |
|---|---|---|
| `check database/change-feed` (536) | 3.3 s (1.6 s cpu + 1.7 s sync-io) | `producer-writes.ts` parses every candidate with `ts.createSourceFile`, the same file up to 4× (one parse per pass), in loops that never yield |
| `checks/theme-bridge-reads` (480) | 2.3 s, 92 % blocking-io | `readFileSync` of every `plugins/**/*.{ts,tsx,css}` in a `for` loop |
| `primitives/launch/investigate` | ~2 s cpu | `indexFile` (= `maskSource` + const scan) re-run over every candidate on each of up to 8 passes |
| `readWorkspace` (deps/npm, 387) | 2.8 s blocking-io | `readFileSync` per `package.json` |
| `snapshot-chain-intact` | — | `readStart` (`openSync`/`readSync`) per migration file |
| `cli` manifest-freeze | — | `readFileSync` per live module of each closure |

Every one is the same class: **per-file synchronous work (a blocking syscall, or a
whole-file parse) in a loop, on the one thread every check shares**. The checks
`CLAUDE.md` already *says* not to ("A check gets its files from `ctx.repo()`, and
never blocks the thread"), and the primitives exist (`ctx.repo().read`,
`createTimeSlicer`, `grepCode`'s sliced loop) — but nothing makes a check use them,
so each new check re-learns it from a report. That is rung 5 (documentation). This
plan moves it to rung 3 and gives the CPU half a primitive whose shape yields by
construction.

## Design

### 1. Sliced, run-shared source derivations — `checks/core/source-work.ts`

The two expensive per-file derivations a check does are masking (comments/strings
blanked) and a TypeScript parse. Both become **async functions that yield before
working** and **memoize for the process** (one check process = one run), so a loop
over thousands of candidates yields every ~10 ms by construction, and a file masked
or parsed by one check / pass is free for the next:

```ts
export function sliceCheckThread(): Promise<void>;                    // the thread's one shared budget
export function maskedSource(src: CandidateSource, opts?: { strings?: boolean }): Promise<string>;
export function parsedTsSource(ts: typeof TS, src: CandidateSource): Promise<TS.SourceFile>;
```

- `sliceCheckThread` is ONE process-wide `createTimeSlicer()` (`packages/macrotask-yield`):
  the budget belongs to the thread, which every check shares — not to a loop.
- Memo key: `rel` (+ the `strings` flag for masks); a hit only when the cached entry's
  `src` is the same string (content equality — a different tree's bytes recompute).
  ASTs are kept the same way; the check process exits after the run.
- `grepCode` / `grepImports` mask through `maskedSource`, so a file grepCode already
  masked is free for investigate & co.

### 2. Lint rule `check-thread-safety/no-blocking-check-work` (rung 3)

In non-test files under a `check/` folder, reports:

- **`blockingCall`** — a blocking fs / process call: the `node:fs` `*Sync` family
  (`readFileSync`, `readSync`, `openSync`, `existsSync`, `statSync`, `lstatSync`,
  `readdirSync`, `realpathSync`, `accessSync`, `readlinkSync`, `writeFileSync`, …),
  `spawnSync` / `execSync` / `execFileSync`, `Bun.spawnSync`, `.scanSync(`. Fix:
  `ctx.repo()` (membership in memory, `read` async and gated) or `node:fs/promises`.
- **`syncParse`** — a direct `maskSource(` or `createSourceFile(`. Fix: `await
  maskedSource(…)` / `await parsedTsSource(…)`.

Anywhere in the file, not only lexically inside a loop: a helper called from a
`.map` is a loop body the rule cannot see, and the async form costs the same to write.
Existing violations outside the culprits fixed here are declared **debt** in each
owning plugin's `exempt/index.ts` (one follow-up task), so the rule holds every new
check from day one and the debt list is the to-do.

The rule cannot see blocking work inside a **core helper** a check calls
(`readWorkspace`, `readStart`, `resolveCheckoutDeploy`, …). Those stay on the thread
watch (rung 4: it names them in reports); the named ones are converted here.

### 3. Convert the reported culprits

- **change-feed** `producer-writes.ts`: every pass parses through `parsedTsSource`
  (one parse per file per run, yielding between files); the pass functions become async.
- **investigate**: `indexFile` masks via `maskedSource` and is memoized per file for the
  run (the 8 passes re-index only new files); async.
- **theme-bridge-reads**: `ctx.repo()` for the file set and `repo.read` for content;
  the scan loops slice.
- **manifest-freeze** (`cli/check`): `repo.read` instead of `readFileSync`.
- **`readWorkspace`** (deps/npm core): `await readFile` per manifest, in parallel.
- **`readStart`** (migrations core): an async `readStartAsync` / `readSnapshotLineageAsync`
  for the check path if the call chain allows; otherwise filed as follow-up.

## Not done here

- Running checks in Workers (would make holding the thread impossible, but `ctx` —
  read-set recording, exemptions, cache — is in-process state; far larger change).
- Converting every debt site; the debt task covers it.

## Verification

1. `./equin test` on checks/core (`source-work` memo + yield test), the lint rule's
   RuleTester, change-feed and investigate check tests.
2. `./equin check` passes (incl. eslint with the new rule + debt entries).
3. `./equin build` → read this run's `check-progress` `stall` records: no
   change-feed / theme-bridge-reads / investigate owner with held ≥ 2 s.
