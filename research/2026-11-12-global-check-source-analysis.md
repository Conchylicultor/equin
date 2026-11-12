# Shared source analysis for checks (fail-closed)

## Context

The icon manifest scan used to guess `symbol(` calls from text and silently
skipped `{ ...symbol("progress-activity") }` — every in-progress task lost its
icon (conv-1794354745-34vama). That conversation rewrote the scan on the TS
syntax tree, refusing any use it cannot read. The pattern stayed local: 24
check files still read imports / declarations with `parse-utils` regexes over
masked text (`findImports`, `matchBracket`, `maskSource`), and aliases,
re-exports, `export *` barrels, ternary initializers, spreads and wrappers
silently escape them (`no-db-backed-notify`'s `ModuleIndex`, `live:*` and
`investigate:*`'s `importAliases` + `const` regexes).

Goal: one shared analysis API for checks that (a) resolves an imported
declaration's uses through aliases / re-exports / barrels, (b) reads a literal
argument, (c) collects FAIL-CLOSED — every use it cannot read comes back as an
`Unreadable` with file:line, never skipped (failure is a type). Pilot: the icon
scan. Downstream tasks port `no-db-backed-notify`, `network/live/check`,
`investigate` onto it.

## Decisions

- **Syntax + the repo project's module resolution, no checker.** "Reuse the
  program type-check builds" is honoured as: the ONE project (`repoProgram(root)`
  → root `tsconfig.json`, its `paths` / `moduleResolution: bundler`) resolves
  every specifier through `ts.resolveModuleName`, over the run's file set
  (`ctx.repo()`), and every file is parsed once per run through the existing
  shared parse memo (`parsedTsSource`, `checks/core/source-work.ts`). There is no
  second tsconfig and no hand-written specifier resolution (the `@plugins/`
  string surgery in `ModuleIndex.resolveSpecifier` / `isIconRefModule` goes).
  A type-checked `ts.Program` is NOT built: type-check's program never exists
  whole in one process (batched, in a worker process, 70–130 s and GBs), and a
  second one on the runner's shared thread is exactly what `type-check/CLAUDE.md`
  forbids. Every question the three downstream checks ask (which binding is
  this import, what does this barrel re-export, what is this const's
  initializer) is a binding question, answered exactly from syntax.
- **Location: a leaf sub-plugin `checks/plugins/source-analysis/core`**, wired for
  checks by `checks/core` (`sourceAnalysis(ctx)`, memoized per run's
  `RepoSnapshot`, so every check in a pass shares one context). A leaf because
  the icon scan is a codegen `FileScan` whose records are keyed by its module's
  import closure — importing the whole `checks/core` barrel (runner, cache,
  grep index) would re-key every icon record on any runner edit.
- **Two layers.**
  1. *Per file, pure, sync* — what a cached per-file scan (the icon pilot) can
     use: given a parsed file and which imports name the target, classify EVERY
     reference.
  2. *Cross-file, async* (`SourceAnalysis`) — module resolution, export
     following through barrels, identifier → declaration, the uses of a target
     declaration across candidate files.

## API (`@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core`)

```ts
interface SourceSite { rel: string; line: number }
interface Unreadable { at: SourceSite; reason: string; text: string }
type Readout<T> = { kind: "read"; value: T } | { kind: "unreadable"; unreadable: Unreadable };
interface Collected<T> { found: T[]; unreadable: Unreadable[] }   // the fail-closed collector

// ── per file ──
targetBindings(ts, sf, rel, isTarget: (specifier, exported) => K | undefined)
  → { named: Map<local, {key: K; exported}>; namespaces: Set<local>; reexports: Reexport<K>[]; unreadable }
targetUses(ts, sf, rel, bindings) → Collected<TargetUse<K>>
  TargetUse = { kind: "call"; key; exported; call; site }        // f(…), ns.f(…), (f)(…)
            | { kind: "member-call"; key; exported; member; call; site }  // Investigate.Register(…)
            | { kind: "reexport"; key; exported; as; site }       // export { f } / export { f } from / export *
  everything else (passed as a value, shadowed, element access on a namespace,
  a namespace used whole) → Unreadable
literalString(ts, sf, rel, expr) → Readout<string>   // string / no-substitution template
callArgument(call, i) → TS.Expression | undefined
failClosed(collected, hint) → T[]   // throws listing every Unreadable (file:line: reason) — for codegen

// ── cross file ──
createSourceAnalysis({ ts, files: RepoFiles, parse, compilerOptions }) → SourceAnalysis
  resolveModule(fromRel, specifier) → {kind:"repo"; rel} | {kind:"external"} | {kind:"missing"}
  exportedDeclaration(rel, name) → Readout<Declaration>   // export {a as b} from, export *, import+export, local alias
  declarationOf(rel, id: TS.Identifier) → Readout<Declaration>  // innermost scope, then imports
  initializerOf(decl) → Readout<TS.Expression>   // `const x = …` only; let/var/param/destructured → unreadable
  usesOf(target: {rel; name}, candidates) → Promise<Collected<TargetUse>>   // through every barrel
  spellings(target) → Promise<string[]>   // every name the target is exported under (pre-filter for candidates)
Declaration = { rel; name; sf; node: TS.Node /* the VariableDeclaration / FunctionDeclaration / ClassDeclaration … */; site }

// checks/core
sourceAnalysis(ctx) → Promise<SourceAnalysis>   // root tsconfig options, ctx.repo(), parsedTsSource
```

Candidate soundness: a file can only use the target by spelling one of its
exported names or through a namespace import (`import * as`), so `usesOf`'s
callers pre-filter with `spellings(target)` ∪ files with `* as`.

## Pilot: the icon scan

`icon-manifest.scan.ts` keeps its `FileScan` contract (per file, no repo) and
becomes: `targetBindings` with `isIconRefModule` as the module test →
`targetUses` → each `call` read with `literalString` → `failClosed`. A
`reexport` is accepted only in an icon-ref module itself (the barrel
re-exporting `./icon-ref`); anywhere else it is Unreadable — the old scan saw
no binding in `export { symbol } from "@…/icons/core"` and silently skipped
every file importing from that re-exporter. Its existing tests keep passing,
plus: re-export outside icons fails, namespace `Icons.symbol("x")` is
collected (was: refused), `Icons[k]("x")` fails.

## Docs

`checks/CLAUDE.md`: a section "Reading code: `sourceAnalysis`, not regexes" —
when to use which layer, the fail-closed contract (report each `Unreadable` as
a violation, or `failClosed` in codegen), the no-checker rationale. Sub-plugin
`CLAUDE.md` with the API.

## Verification

- Unit tests: `source-analysis/core/*.test.ts` (per-file classification table;
  cross-file over an in-memory `RepoFiles`: aliased import, barrel `export {}
  from`, `export *` chain, import-then-export, local alias, namespace import,
  cycle, external package, missing file), icon scan tests.
- `./equin build` (icon manifest regenerated unchanged), `./equin check`,
  `./equin test` on `checks`, `codegen`, `source-analysis`, `ui/icons`.
