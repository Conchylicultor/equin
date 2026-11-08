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

## 4. paths dataRoot() / worktreesDir() — not landed: a proposal

What blocks it: `dataRoot()` is read synchronously from ~60 call sites and every
`DataDir.path` / `.file()` getter (hundreds), in every kind of process, and
decides the home layout lazily on first read (2 `lstat` + ≤ 2 `realpath`). The
`movedFrom` resolution behind the getters is the same shape and can even
*perform* a move (`renameSync`) on the host singleton. The gateway decides the
same layout (`gateway/main.go dataRoot`) but does not hand it to its children.

Proposal (the `runtime-identity` pattern, applied to the root):
1. **Declared at entry, carried by the environment.** `declareDataRoot(layout)`
   at a process tree's root writes the decided layout into its own env
   (`EQUIN_DIR` + the layout kind, so `backupsDir` keeps its legacy answer), so
   every child and worker inherits a decided root. `dataRoot()` reads only the
   declaration: pure, and an undeclared read throws loudly.
2. **Who decides:** the gateway passes it to every backend it spawns (it already
   computes it); tool roots decide synchronously in their entry (`bin/` /
   `cli/`: the CLI, the guard hooks, `./equin run` for its child, the bun test
   preload and the vitest setup, drizzle-kit via the build's spawn env).
3. **Moves at boot.** `settleDataDirMoves()` awaited by the host singleton
   before it listens (the sanctioned "before the backend listens" case); a
   getter that meets an unsettled move in a backend throws.
The risk is the landing: one missed process root crashes on its first path
read, main's backend included, so it wants its own task, a list of every
process root and a boot test per root.
