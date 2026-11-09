# The last 11 blocking-fs/sync-named debt exemptions

Part of the responsiveness audit (task-1793965642-94fdhj); follows
research/2026-11-08-global-sync-named-debt-paydown.md (task-1793991095-ppkf09).
Four groups, filed as task-1794173014-p74c8g, -16-8ngbho, -19-u9ipmw,
-22-iba8kx.

## Before → after

`./equin exempt list --rule blocking-fs/sync-named --debt`: **11 → 2** (both
in `infra/paths`, group 4, proposal below). The guards' six became
`sanctioned`, held by `blocking-fs:sync-named-reach`; source-digest's and
faceted's three are gone (no sync call left).

## 1. Guards — cut the reach (6 → sanctioned)

Backends loaded `guards/core` for two constants, and the barrel pulled the
whole guard registry (every guard and the blocking helpers they run in the
hook process). Both constants now live in leaves:

- `guards/tool-use-id` (core): `TOOL_USE_ID_RE`, `toolUseIdFrom` — read by
  browser-recordings (server + writer core) and the e2e recorder.
- `guards/bypass-tokens` (core): `BYPASS_TOKENS` **declared as data**, plus
  `BypassToken` and `isBypassToken`. It used to be derived from the registry
  (the reason backends loaded it). The two halves cannot drift: a guard's
  `bypassToken` is typed `BypassToken` (tsc refuses an undeclared file), and
  the new `guards:bypass-tokens-declared` check fails on a declared file no
  guard (built-in or plugin-contributed) honours.

`guards/core` no longer re-exports either. The seven guard files (the old
sanctioned `informed-once.ts` folded in) are one `sanctioned` exemption;
`blocking-fs:sync-named-reach` passes, so no backend module reaches them.

## 2. source-digest — an async resolver, measured

What it costs, on a serving backend's entry closure (server-core/bin/index.ts:
5,419 files, 18,468 imports), thread CPU of `closureChangedSince`, Bun 1.4.4:

| | cold (first walk of a process) | warm (later walks) |
|---|---|---|
| before (`Bun.resolveSync`) | 530 ms | 70 ms |
| after (`shared/resolve.ts`) | 325 ms | 83 ms |

The 270 ms cold `resolveSync` share was stat-on-the-thread: the call that stalls
for seconds under disk load. Warm, `resolveSync` answers from Bun's in-process
directory cache — which never re-reads a directory (measured: it returned a file
already deleted), so the walk's promise that "a new file shadowing an import is
seen" did not hold. The new resolver reads each touched directory once per walk
(async `readdir`, ~2,400 directories: 3 ms of thread CPU) and answers every
candidate from that listing synchronously; settled answers are memoized per walk
so a barrel imported by many files resolves once. The extra 13 ms warm buys a
fresh view of the tree and no disk wait on the thread.

Its rules are Bun's for what this repo imports, and it fails closed on the rest:
- relative / absolute / `tsconfig.base.json` aliases (the single alias owner):
  exact file, else the first extension in Bun 1.4.4's measured order
  (`.tsx .jsx .mts .ts .mjs .js .cts .cjs .json`, the same for `index`), a file
  before a directory, else a `.js`-family TypeScript twin — two twins, or a twin
  beside an appended extension, is refused (order not measured);
- a directory whose package.json names `main` / `module` / `exports`: refused;
- a bare specifier: the first `node_modules/<name>` entry up the tree, its real
  directory (packages are counted by `name@version`, never walked); a link out
  of every `node_modules` (a workspace link) is refused; `#imports` refused;
- canonical paths: entries are realpath'd, a resolved path crossing a symlink
  is realpath'd (Bun's own realpath behaviour under `/tmp` was inconsistent
  between runs, so the walk defines its own canonical spelling).

`resolve.test.ts` holds it to `Bun.resolveSync` import by import over the
backend's and central's real closures (a test: `resolveSync` in a check would
be blocking check work). Files and packages are counted as before, so a
digest of unchanged code should not move.

## 3. faceted — readOutside is async

`readOutside` (a gitignored module's content, for the plugin-records module
graph) was a synchronous member of the keying input; the faceted index (its
worker) and `buildFacetedPluginTree` (which `review/plugin-changes` runs on a
backend) passed a `readOutsideSync` that stat'd and read on the thread. Every
use was already inside an async walk, so the graph now awaits it:
`OutsideFiles = (rel) => Promise<string | null>`, memoized per graph as a
promise, probed one candidate at a time (each probe reads the file), and one
reader `outsideFilesAt(root)` (plugin-records core) replaces the four
hand-written sync readers (faceted ×2, codegen file-scans, evaluated-barrels,
and the closure-equivalence script).

## 4. paths dataRoot() / worktreesDir() — step 1 landed (att-1794175174-tw1uos)

Landed as step 1 of 3: the layout is **declared at each process tree's root
and carried by the environment** (`EQUIN_DATA_ROOT_LAYOUT` = `current` |
`current-legacy-link` | `legacy`); `dataRootLayout()` reads it. Roots: the
`./equin` wrapper (`paths/scripts/declare-data-root.sh`, held to the TS rule
on 10 home shapes), the CLI's `bin/index.ts`, the gateway for every child
(`gateway/dataroot.go`, same shapes in Go), each backend's serving entry
(first import, before listen), the guard hooks, the `bun test` preload; a
release sets `EQUIN_DIR`. Table: infra/paths `CLAUDE.md` § The data root.

Measured constraint that shaped it (Bun 1.4.4): a `Bun.spawn` child with no
explicit `env`, and a `new Worker` without `{ env }`, get the parent's STARTING
environment, not its `process.env` writes; `node:child_process` and
`infra/spawn` (which pass `process.env`) do see them. So an in-process
declaration covers the process itself; the tree's starters (wrapper, gateway)
must put it in the starting environment.

What is left:
- **Step 2:** the transitional fallback (an undeclared process decides on its
  first read and prints `[paths] data root undeclared …` once) becomes a throw,
  paying `paths.ts`'s debt. Wait until the gateway has been restarted onto this
  code (`./equin start --force`) and the warning has stopped appearing in the
  logs; the warning names each missed root's argv.
- **Step 3 — landed** (att-1794187184-wd4npx): the moves are settled at each
  process tree's entry (`settleDeclaredDataDirMoves`, async — a backend's
  `serve` before the socket binds, the only place a move is performed; an
  `exec` boot; `paths:logs-claimed`) and declared through the environment
  (`EQUIN_DATA_DIR_MOVES`: the root inspected + each move's state). The getters
  read the declaration only; an undeclared read of a moved dir throws
  `DataDirMovesUndeclaredError`. A non-mover's pending answer (OLD) stays
  right after main moves, through the shim. The debt entry is gone.
  Original statement — `movedFrom` (`data-dir.ts`): the getters
  inspect a move with `lstat` once per move per process, and the host singleton
  performs it with `renameSync`. Settle moves before the backend listens. The
  `blocking-fs/sync-named` rule did not see this: a `const xSync = () =>`
  helper (an arrow's declaration has no name) was not recognised as blocking
  where it is called. Fixed in this task: the rule reads a variable-bound
  function (arrow, function expression, through `as` / `satisfies`, a property,
  a function-typed binding) by its binding's name. The whole repo was re-linted
  (15,564 files): 6 new violations, all in `data-dir.ts`'s getters, declared as
  debt naming that task.
