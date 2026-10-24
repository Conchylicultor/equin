# A plugin contributes a CLI command

## Context

`./equin <cmd>` is the one contribution surface the repo never opened.
`bin/cli.ts` hand-registers 14 commands — one `import` + one `register*(program)`
per file under `bin/commands/` — and all 14 live inside the framework CLI plugin.
A plugin that needs a terminal verb has nowhere to put it, so the only way to
ship one is to add app knowledge to the framework CLI. That contradicts the rule
the whole repo is built on: every feature is a plugin, the core is thin plumbing.

Every other build-time contribution is already collected generically —
`check/`, `lint/`, `data-dirs/`, `facet/`, `provision/`, `prewarm/`, `vite/`,
`fixtures/` all go through `defineCollectedDir` + one codegen pass. The CLI is
the outlier, and closing that gap is mostly *using* machinery that already
exists.

Two halves, and the second is what makes the first trustworthy:

1. Plugins get a `cli/` contribution folder.
2. The 14 existing commands are expressed through it — including `build`,
   `push` and `check`, whose orphan guard, host locks and lane classification
   are the load-bearing cases a toy mechanism would not survive.

The first outside consumer is `./equin prototype new`, so the Prototypes
app mints a prototype folder itself instead of an agent typing
`cp -R _template <name>`. **That command is out of scope for this plan** — it is
a separate task, and it lands on the mechanism below with no changes to it.

### What the CLI bootstrap already demands

Three constraints, all real, all currently enforced by checks:

- **`bin/index.ts` may statically import no npm package.** It is the process
  that *runs* `bun install`; static imports hoist above every statement, so one
  `import "commander"` there makes a fresh checkout die before the CLI can
  repair its own `node_modules`. Enforced by `cli:bootstrap-package-free`
  (`plugins/framework/plugins/cli/check/index.ts`).
- **A process that installs must re-exec before resolving a package** — Bun's
  resolver caches directory listings from before the install (`bin/reexec.ts`).
- **Commander wants a command's name, flags and help before it parses.** So a
  contribution's *declaration* is reached on every single `./equin`
  invocation, including the hot `build` path, while its *implementation* must
  not be.

A fourth, easy to miss: `cli:codegen-manifests-not-frozen` measures the whole
CLI process's import closure *following literal dynamic edges*. Everything the
new registry reaches is inside that subject, which is a feature — the freeze
invariant extends to plugin-contributed commands for free.

## The mechanism

### `cli/` becomes a collected dir

A plugin contributes `plugins/<name>/cli/index.ts` default-exporting
`CliCommand | CliCommand[]`. Everything downstream is existing machinery:

- `plugins/framework/plugins/cli/core/collected-dir.ts` calls
  `defineCollectedDir("cli")` — the marker `discoverCollectedDirs` regex-scans
  for (`codegen/core/plugin-registry-gen.ts:80`).
- Codegen emits `plugins/framework/plugins/cli/core/cli.generated.ts` exporting
  `cliEntries: CollectedEntry[]`, each `{ pluginPath, id, loader: () =>
  import("@plugins/<path>/cli"), dependsOn }`. Registering a command is creating
  a folder and rebuilding — never editing a list.
- `standardPluginDirs` grows automatically; `plugins-registry-in-sync` starts
  asserting the new registry with no special-casing.

This lands `cli.generated.ts` in the same family as `check.generated.ts` and
`data-dirs.generated.ts` — registry-phase outputs, explicitly out of scope of
the manifest-freeze check (see its `SCOPE` docblock). It must **not** be
registered as a pre-barrel manifest.

### The declaration is closed data, not a commander passthrough

Across all 14 commands the entire commander surface used is `command`,
`description`, `argument`, `option`, `requiredOption`, `action`. Nothing else.
So the declaration can be a **closed** shape rather than an escape hatch — a
contributor cannot reach for a commander feature the mapper does not model,
because it cannot import commander at all (`commander` is a workspace-local dep
of the CLI plugin; it would not even resolve).

In `plugins/framework/plugins/cli/core/` (new `internal/command.ts`, re-exported
from the existing `core/index.ts`):

```ts
export interface CliArgumentSpec {
  /** commander argument syntax: "<name>" | "[name]" | "[name...]" */
  readonly name: string;
  readonly description: string;
  readonly defaultValue?: string;
}
export interface CliOptionSpec {
  /** commander flag syntax: "--force" | "--name <name>" | "--no-cache" | "--x <n...>" */
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: string | boolean;
  /** → requiredOption */
  readonly required?: boolean;
}

/** Commander hands an action (...declaredArgs, options, Command); the mapper
 *  drops the trailing Command, so this IS the shape it is called with. */
export type CliAction<A extends readonly unknown[], O> = (...args: [...A, O]) => Promise<void>;
```

A command is a **leaf** (it runs) or a **group** (it has subcommands), never
both — a union with mutually-exclusive `never` arms, so the wrong shape is a
type error rather than a runtime check:

```ts
type CliCommand<A, O> =
  | { name; description; arguments?; options?; detachable?;
      run: () => Promise<{ default: CliAction<A, O> }>; subcommands?: never }
  | { name; description; subcommands: readonly AnyCliCommand[];
      run?: never; arguments?: never; options?: never };

export function defineCliCommand<A extends readonly unknown[] = [], O = object>(
  spec: CliCommandSpec<A, O>,
): CliCommand<A, O>;
```

`run` returns the *module*, not the function, so the implementation is reached
only when the command actually runs. The declared `A`/`O` flow through the
loader's return type into the implementation module's default export, so the
action's parameters are type-checked against the declaration — the 14 existing
actions already carry exactly these hand-written parameter types.

`deploy` (`converge`, `ship`) and `db` (`fork`, …) are groups; the mapper
recurses.

### Where the declaration ends, and the check that keeps it there

`bin/register-commands.ts` (host, `bin/`, the one place that touches commander):

```ts
function attach(parent: Command, spec: AnyCliCommand): void {
  const cmd = parent.command(spec.name).description(spec.description);
  if (spec.subcommands) { for (const s of spec.subcommands) attach(cmd, s); return; }
  for (const a of spec.arguments ?? []) cmd.argument(a.name, a.description, a.defaultValue);
  for (const o of spec.options ?? [])
    (o.required ? cmd.requiredOption : cmd.option).call(cmd, o.flags, o.description, o.defaultValue);
  cmd.action(async (...argv) => {
    if (spec.detachable === true) disarmOrphanGuard();   // see below
    const { default: run } = await spec.run();
    await run(...argv.slice(0, -1));                     // drop commander's trailing Command
  });
}
```

`bin/cli.ts` becomes: load `cliEntries`, assert unique names, sort by name,
`attach` each, `runCli(program)`. It imports no command file.

**New check `cli:command-declarations-light`.** For every `plugins/*/cli/index.ts`
with a default export, its static import closure (dynamic edges cut) may reach
no npm package and no `*/web` or `*/server` barrel. This is the eager-cost
invariant stated directly, and it is measured with the `importClosure` helper
that already exists in `plugins/framework/plugins/cli/check/index.ts` — same
`Bun.build` technique, same `stopAtDynamicImport` option, no second scanner.

**New check `cli:command-names-unique`.** Loads every declaration and fails if
two plugins claim the same verb at the same level. Without it, the first
collision would surface as one command silently disappearing.

**`loadCollectedDir` gains `strict: true`.** It currently warns and continues on
a rejected loader, which is right for facets and wrong here — a broken
declaration must not read as "that command does not exist". `lint` and
`provision` each hand-rolled a fail-loud loader to escape this; adding the option
means the CLI does not become a third copy.

### The orphan guard stops asking argv[2]

Today `bin/index.ts:63` reads `process.argv[2]` against a hardcoded
`{build, check, push}` set, before the install and before any flag parsing, to
arm the guard that exits an op once its invoking shell dies. That set is the
last thing coupling the bootstrap to a command list.

**Invert it.** `bin/index.ts` arms the guard unconditionally — one `unref`'d 2 s
`ppid` poll, which costs nothing — and reads no argv at all. `installOrphanGuard`
keeps its `SINGULARITY_BUILD_DETACHED` escape and gains a module-level
`disarmOrphanGuard()`; the mapper calls it at the top of the action wrapper for a
command declaring `detachable: true`. Same process, same module instance, so the
handle needs no plumbing.

There is then no command set in the bootstrap, nothing to keep in sync, and no
check to enforce agreement — the property is expressed once, on the command
itself. The pre-install window is now guarded for *every* invocation, which is
strictly safer than today.

Two consequences, both stated rather than discovered later:

- **`serve-app` declares `detachable: true`** — it boots a full runtime in
  process and is legitimately run under `nohup`. `start` is a judgement call: it
  spawns the gateway detached and then only waits for readiness, so the guard is
  harmless; leave it guarded unless the readiness wait proves to matter.
- **Long non-op commands become guarded** — `release`, `deploy`, `test`. An
  orphaned one now exits 140 instead of running on. That is the intended
  direction (an orphaned `release` holds `.build.lock` through its hermetic
  child), but it *is* a behaviour change for anyone backgrounding them.

`release.ts:754` and `internal/hermetic-build.ts:79` both document a *reliance*
on argv[2] matching, so the hermetic child is guarded. Under always-arm that
reliance is satisfied by construction; both comments need rewriting to say so.

### Registering `cli` as a runtime

- **`boundary-config.ts`** — add `cli: ["cli", "core", "shared", "data-dirs", "server"]`.
  A CLI command is a host process, like a server: it may reach `core`, its own
  `shared`, declared data dirs, other plugins' `server` barrels, and other
  plugins' `cli` barrels. That last edge is what lets shared CLI machinery live
  in a `cli/` barrel — the same shape `provision` uses for the one chromium
  installer, and `tooling/plugins/e2e-harness/e2e` uses for the shared Playwright
  harness. `runtimeNames` derives from these keys, so `@plugins/<p>/cli` becomes
  a legal cross-plugin barrel with no other edit.

  The eager-weight constraint is **not** carried by this row — a declaration may
  sit next to an implementation that reaches a server barrel, because only
  `cli/index.ts` is measured, and only through its static edges.

- **`plugin-id/core/plugin-id.ts`** — add `"cli"` to `RUNTIME_FOLDERS` and a
  `cli:` entry to `RUNTIME_FOLDER_DOCUMENTED` (the record is exhaustive, so this
  is a type error until declared). Set it `true`: unlike `e2e`/`provision`,
  "which verb does this plugin already ship" is exactly what an agent should be
  able to read out of `docs/plugins-details.md` before adding a second one.

- **`plugins/framework/plugins/cli/tsconfig.json`** — add
  `"../../../../**/plugins/*/cli"` to `include`. Required by
  `collected-dir-tsconfig-coverage`, and by `type-check`'s "lintable file belongs
  to no tsconfig program" assertion. It belongs in the CLI plugin's own program
  rather than server-core's, because that is where `commander` resolves.

## The split

`framework/cli` keeps only what is genuinely the host, and every command becomes
its own sub-plugin. Four support sub-plugins carry what more than one command
needs — today those helpers sit in `bin/`, which a sibling sub-plugin cannot
reach, and `shared/` is plugin-private so it cannot carry them either.

```
plugins/framework/plugins/cli/
  bin/            index.ts, cli.ts, register-commands.ts, run-cli.ts   ← host only
  core/           merge markers (unchanged) + defineCliCommand + collected-dir
                  + cli.generated.ts
  data-dirs/      buildProgressLogDir (unchanged, imported cross-plugin)
  check/          + cli:command-declarations-light, cli:command-names-unique
  plugins/
    bootstrap/cli/     ensure-deps, reexec, orphan-guard, build-lock, adaptive-timeout
    op-runtime/cli/    broadcasts, build-receipt, fatal-signals, signal-origin-{tap,log},
                       lane, paths, profiler, build-progress, admission-valve,
                       check-subprocess, build-output, build-logs-writer, cli-crash
    migrations/cli/    migrations, migrations-interactive
    git-artifacts/cli/ normalize-generated, register-merge-drivers
    build/  check/  push/  release/  deploy/  db/  test/  format/  start/
    serve-app/  apply-migrations/  regen-generated/  regen-migrations/
    normalize-generated/
```

Each command sub-plugin is `cli/index.ts` (the declaration) plus its
implementation beside it — `cli/run.ts` default-exporting the action, and
whatever internals it owns.

Two findings that shrink the job:

- **`bin/commands/internal/*` is entirely build-private.** `app-artifacts`,
  `build-targets`, `deploy-namespace`, `dist-publish`, `experimental-marker`,
  `hermetic-build`, `legacy-dist-reap` are reached only from `build.ts` and each
  other; `converge-script` only from `deploy.ts`. They move *into* their command's
  sub-plugin — no shared "app-build" plugin is needed. `release` couples to build
  only by spawning `build --hermetic` as a subprocess.
- **`bootstrap/cli` inherits the package-free constraint.** `bin/index.ts` will
  import that one barrel, so `cli:bootstrap-package-free` measures it
  automatically. It is the reason `build-lock` and `adaptive-timeout` land there
  rather than in `op-runtime`: `ensure-deps` imports `build-lock`, and
  `build-lock` imports `adaptive-timeout`, so both are already in the pre-install
  closure today. Nothing npm-reaching may be added to that barrel.

Each sub-plugin gets a `package.json` (`@singularity/plugin-framework-cli-<name>`,
private) and a `CLAUDE.md`. The `package.json` MUST carry a `description`:
a command sub-plugin has no web/server/central barrel, and that barrel is the only
other place `buildPluginTree` reads one from — without it the plugin lands in
`docs/plugins-compact.md`, which is auto-loaded into every agent's context, as a
bare name with no description. (Found in Phase 1; the `package.json` fallback
already exists in `plugin-tree.ts`, so nothing had to be built for it.) Command-specific npm deps move off the host:
`pg` → `build` + `apply-migrations`, `@resvg/resvg-js` → `release`. `commander`
stays with the host, which is now its only importer.

`bin/*.test.ts` move with their subjects.

`serve-app`'s `--repo-root` default is `REPO_ROOT` from a **server** barrel,
which a declaration may not statically import. Drop the commander default and
resolve it in the action (`opts.repoRoot ?? REPO_ROOT`), with the help text
saying so. It is the only such case across the 14.

## Execution

Phases 1, 2 and 4 are serial. Phase 3 fans out — and the point of the mechanism
is that it can: each command agent creates one folder and edits no shared file,
because the registry is generated rather than hand-edited. There is nothing for
two agents to conflict on.

**Phase 1 — the mechanism (serial).** `defineCollectedDir("cli")`, the
declaration types + `defineCliCommand`, `register-commands.ts`, the rewritten
`bin/cli.ts`, `loadCollectedDir`'s `strict` option, the orphan-guard inversion,
the two new checks, and the `boundary-config` / `plugin-id` / `tsconfig`
registrations. Prove it end to end by migrating exactly one command — `format`,
32 lines, no shared helpers — into `plugins/format/`. `./equin build` and
`./equin format` must both work with 13 commands still hand-registered
alongside the mechanism.

**Phase 2 — the support sub-plugins (serial).** Create `bootstrap`,
`op-runtime`, `migrations`, `git-artifacts` as pure file moves plus a barrel
each, and re-point today's `bin/commands/*.ts` at them. No command changes yet,
so this phase is verifiable on its own: `./equin check` and a real
`./equin build` still pass with the commands untouched. This must land
before Phase 3 or every command agent would be moving the same files.

**Phase 3 — the 13 remaining commands (parallel agents).** One agent per
sub-plugin, each converting `bin/commands/<x>.ts` into
`plugins/<x>/cli/{index.ts,run.ts,…}`. Every agent gets the same contract: the
declaration is data only, the action moves verbatim, imports re-point at the
Phase-2 barrels, and `bin/cli.ts` is not touched. Sizing: `build` (1658),
`release` (1486), `deploy` (982), `push` (626), `check` (398) are Opus work — they
carry the host grants, the op profiler, the lane inheritance and the stage
sequences. `db`, `test`, `start`, `serve-app`, `regen-migrations`,
`regen-generated`, `apply-migrations`, `normalize-generated` are mechanical and
can be batched.

**Phase 4 — close it out (serial).** Delete `bin/commands/`, delete the
`register*` exports, rewrite `plugins/framework/plugins/cli/CLAUDE.md` (its
command table, its op-command section, and its "everything shared lives in
`bin/`" opening paragraph are all now wrong), fix the two argv[2] comments in
`release.ts` / `hermetic-build.ts`, and run a full `./equin build`.

## Files that matter

- `plugins/framework/plugins/cli/bin/index.ts` — arm unconditionally, drop the argv[2] read
- `plugins/framework/plugins/cli/bin/orphan-guard.ts` — delete `OP_COMMANDS`/`isOpCommand`, add `disarmOrphanGuard`
- `plugins/framework/plugins/cli/bin/cli.ts` — registry-driven; new `bin/register-commands.ts`
- `plugins/framework/plugins/cli/core/{index,collected-dir,internal/command}.ts`
- `plugins/framework/plugins/cli/check/index.ts` — two new checks, reusing `importClosure`
- `plugins/framework/plugins/tooling/plugins/collected-dir/core/load-collected-dir.ts` — `strict`
- `plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts` — the `cli` runtime row
- `plugins/framework/plugins/plugin-id/core/plugin-id.ts` — `RUNTIME_FOLDERS` + doc policy
- `plugins/framework/plugins/cli/tsconfig.json` — the `cli/` include

Existing helpers to reuse rather than re-derive: `importClosure` +
`aliasSpecifiers` (`framework/cli/check/index.ts`), `loadCollectedDir`,
`discoverCollectedDirs` / `renderCollectedDirRegistry`
(`codegen/core/plugin-registry-gen.ts`), and `provision/scripts/run-provisions.ts`
as the precedent for fail-loud contribution loading.

## Verification

Each phase ends green on `./equin build` — the plan is not verifiable only
at the end.

- `./equin check` — `plugins-registry-in-sync` accepts `cli.generated.ts`;
  `collected-dir-tsconfig-coverage`, `plugin-boundaries`, `type-check`,
  `cli:bootstrap-package-free` and `cli:codegen-manifests-not-frozen` all pass
  with the new closure; the two new checks pass.
- `./equin --help` lists all 14 verbs; `./equin deploy --help` and
  `db --help` show their subcommand trees; `build --help` shows all 11 flags with
  their defaults; `check --help` shows the `[checks...]` variadic.
- Real runs of the load-bearing paths: `./equin build` (the whole point),
  `./equin check --list`, `./equin check --status`,
  `./equin format`, `./equin push --help`.
- **Eager weight.** Measure the CLI process's module closure before and after
  with the same `Bun.build` technique the checks use. Today every invocation
  loads all 14 command modules — `pg`, `drizzle-orm`, `@resvg/resvg-js` and ~14
  plugin server barrels — for `./equin format`. After, it should load 18
  data-only declarations plus one implementation. This is expected to make the
  hot path *faster*; record the number either way rather than assuming.
- **Orphan guard.** Start `./equin check` from a shell, kill the shell,
  confirm the CLI exits 140 within ~2 s and drops its grant. Confirm
  `SINGULARITY_BUILD_DETACHED=1` still exempts the detached self-restart build.
  Confirm `nohup ./equin serve-app …` survives its parent (the `detachable`
  path). Confirm a fresh-checkout bootstrap still works:
  `rm -rf node_modules && ./equin check` must install and re-exec, which is
  the case `bootstrap/cli` being package-free protects.
- `./equin test plugins/framework/plugins/cli` — the moved `bin/*.test.ts`
  suites (ensure-deps, reexec, build-lock, build-output, build-receipt,
  migrations, run-cli, adaptive-timeout, converge-script, dist-publish,
  hermetic-build, legacy-dist-reap) all still pass from their new homes.

## What this deliberately does not do

`./equin prototype new` is a separate task on top of this one. When it
lands it is one folder — `plugins/apps/plugins/prototypes/plugins/files/cli/` —
with a data declaration and an implementation that reads `prototypesDir` from
the plugin's own `data-dirs/`. No edit to the framework CLI, which is the whole
point.

## Agent model

Every implementation agent in Phases 1–4 runs on **Opus**, including the
mechanical Phase-3 batch (`db`, `test`, `start`, `serve-app`, `regen-migrations`,
`regen-generated`, `apply-migrations`, `normalize-generated`). "Mechanical" in
the phasing above describes how much design judgement a command needs, not which
model converts it — a verbatim action move that silently drops a flag default or
an exit-code path is exactly the failure a cheaper model produces and a reviewer
does not see.

## Measured: the eager cost (end of Phase 1)

Measured with the same `Bun.build` technique the CLI plugin's own checks use, so
the numbers cannot drift from what actually loads.

| entrypoint | modules | npm packages |
|---|---|---|
| `bin/index.ts`, dynamic edges CUT — the pre-install bootstrap | 11 | **0** |
| `bin/cli.ts`, dynamic edges CUT — **what every invocation pays today** | 347 | 12 |
| one declaration (`format/cli/index.ts`) | 2 | 0 |
| one heavy body still eager (`bin/commands/release.ts`) | 111 | 4 |

Today `./equin format` — or the `build` hot path — loads all 347, pulling
`@resvg/resvg-js` (only `release` rasterizes an icon), `pg` + `drizzle-orm`
(only `build`/`db`/`apply-migrations`), `esbuild`, `jsonc-parser` and
`react-icons/md`. After Phase 3 the eager set is the bootstrap plus `cli.ts`,
`register-commands.ts` and 14 two-module declarations — with `commander` the
only npm package left, everything else behind the declaration's own lazy
`import()`. The plan's claim that this makes the hot path lighter is confirmed,
with the caveat that the full before/after can only be re-measured at Phase 4.

The bootstrap row is the one that must never move: 0 npm packages is
`cli:bootstrap-package-free` holding, and it is what makes `rm -rf node_modules
&& ./equin build` recoverable from inside the repo.

## Outcome (all four phases landed)

`BUILD OK — deployed`, every check green including the two new ones.

### The eager cost, before and after

| entrypoint | before | after |
|---|---|---|
| **every `./equin` invocation** (`bin/cli.ts` static graph) | 347 modules, 12 npm | **41 modules, 1 npm (`commander`)** |
| pre-install bootstrap (`bin/index.ts`, dynamic cut) | 11 modules, 0 npm | **11 modules, 0 npm** |

`pg`, `drizzle-orm`, `@resvg/resvg-js`, `esbuild`, `jsonc-parser` and
`react-icons/md` are gone from the hot path — `./equin format` no longer
loads an SVG rasterizer. The bootstrap row is unchanged, which is the invariant
that keeps `rm -rf node_modules && ./equin build` recoverable.

### What the checks caught that review would not have

Four **path-keyed allowlists** broke, each keyed on a string a file move
silently invalidates. Three were existing, justified entries whose path went
stale (`spawn-safety` → `migrations-interactive.ts`, `paths:data-root-not-joined`
→ `serve-app`, `no-adhoc-check-runner`'s `OWNER_FILE`); one needed a genuinely new
entry (`no-console-log` for `cli/`, approved by the owner). This is the standing
cost of path-keyed exemptions in this repo and worth knowing before the next
large move.

One break **no check could see**: `mise.toml` invokes
`bun …/cli/bin/ensure-deps.ts` by path in its setup task, and that file moved in
Phase 2. Nothing type-checks a shell snippet inside a TOML file, so a fresh
`mise` setup would have died on a missing file. Found by sweeping for stale
paths, not by any gate.

### The self-hosting deadlock

`cli.generated.ts` is produced BY `./equin build`. The moment `build`
stopped being hand-registered, the committed registry — still listing only
`format` — was the only thing telling the CLI that `build` existed, and
`./equin build` answered `unknown command 'build'`. Every route back was
another CLI command that was equally invisible.

Recovery is to call `generatePluginRegistry({ root })` directly from a script
**inside the repo** (the `@plugins/*` alias does not resolve outside the tree).
From here the committed registry always carries `build`, so this is a migration
hazard rather than a standing one — but the failure mode is total when it fires,
and it is worth a documented escape hatch. Whether `build` should stay
hand-registered as a bootstrap floor is a live question the plan did not
anticipate; doing so would reintroduce exactly the coupling this task removed.

### Test suite

6878 pass / 7 fail (bun) plus 6 vitest failures, none in the CLI plugin: sonata
piano-roll geometry, the sentinel worker latch, the contributions facet
declaration guard, `withHostGrant`, `readDatabaseConfig`, adaptive-bar,
element-picker. Four still fail in isolation, so they are not merely
order-dependent. Attribution evidence: the diff touches no file under `sonata`,
`sentinel` or `facets/plugins/contributions`, and the one theoretical link
(the contributions facet reading `RUNTIME_FOLDERS`, which this task extended)
does not exist — that facet never reads it. NOT proven against a pristine
baseline run; the claim rests on reachability, not on a clean-tree comparison.
