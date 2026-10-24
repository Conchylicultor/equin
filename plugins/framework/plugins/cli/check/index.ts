import { builtinModules } from "node:module";
import { relative } from "node:path";
import {
  postWebManifests,
  preBarrelManifests,
  writePreBarrelManifest,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  cliEntrySourcePath,
  isCliCommand,
  isCliEntryPresent,
  type CliCommand,
} from "../core";
import { importClosure } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { measureManifestFreeze, type FreezeFinding } from "./manifest-freeze";
import legacyCliNameCheck from "./legacy-cli-name";

const BOOTSTRAP = "plugins/framework/plugins/cli/bin/index.ts";
/**
 * The same file as {@link BOOTSTRAP}, named for the OTHER subject it serves.
 * The two checks below measure this one entrypoint with opposite dynamic-edge
 * policies, and the names say which question is being asked: `BOOTSTRAP` is the
 * pre-install HOISTING subject (dynamic edges cut), `CLI_ENTRY` is the CLI
 * PROCESS's startup (dynamic edges followed — so `await import("./cli")` and
 * every declaration loader are traversed — except each command's `run` thunk).
 */
const CLI_ENTRY = BOOTSTRAP;
const CLI_BODY = "plugins/framework/plugins/cli/bin/cli.ts";

/**
 * The builtin names legally importable WITHOUT the `node:` prefix, from the
 * runtime's own list rather than a hardcoded copy, so a new Node release's module
 * never reads as an npm package. Deliberately excludes the `node:`-only entries
 * (`node:test`, `node:sqlite`, …): those are covered by the prefix rule below,
 * and stripping their prefix here would make a bare `import "test"` — a real npm
 * package name — look like a builtin.
 */
const BARE_BUILTINS = new Set(
  builtinModules.filter((m) => !m.startsWith("node:")),
);

/**
 * Resolvable with `node_modules` ABSENT: Bun/Node builtins are compiled into the
 * runtime. Everything else non-relative and non-aliased is an installed package.
 */
function resolvesWithoutNodeModules(spec: string): boolean {
  if (spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:"))
    return true;
  return BARE_BUILTINS.has(spec);
}

/**
 * A registered pre-barrel or post-web codegen manifest may not be LOADED by a
 * CLI process that later REGENERATES it. Measured as two rules, because a CLI
 * process is two closures:
 *   1. the STARTUP closure — what every `./equin` invocation loads, whatever
 *      the verb — may load no manifest at all;
 *   2. the RUN closure of every command that regenerates the manifests in-process
 *      may load no manifest either.
 *
 * WHY, precisely — this is a correctness invariant guarding authored user data,
 * not tidiness. Bun's ESM cache freezes a module on its first `import()`, and a
 * later disk write cannot invalidate it. Stage 2 of the build pipeline
 * (`generateAppSources` → `regenerateManifestCodegen`) REGENERATES every
 * pre-barrel manifest and then imports every plugin barrel to collect the
 * config_v2 descriptors those barrels register at module-load. A manifest the
 * process already imported is rewritten on disk and NEVER re-read: the barrels
 * then register the PREVIOUS run's descriptor set, `generateConfigOrigins`
 * records that stale set, and `pruneOrphanedConfigFiles` DELETES a
 * freshly-authored config override as an orphan. Silent data loss, with no
 * failing step to point at.
 *
 * THIS IS THE ONLY MECHANICAL PROTECTION against a load-time freeze. The two
 * things that look like they cover it do not:
 *   - `assertPreBarrelManifestsFresh` (the runtime freeze-point guard) re-renders
 *     each manifest and compares TO DISK. On a load-time freeze the disk copy is
 *     fresh — stage 2 just wrote it — so the guard passes green while the frozen
 *     copy in memory is a run behind. It detects an ORDERING mistake inside the
 *     pipeline, not a freeze that happened before the pipeline started.
 *   - `pre-barrel-manifests-complete` answers a different question entirely: is a
 *     barrel-reachable `*.generated.ts` registered as a manifest at all. It says
 *     nothing about who else imported one.
 * Nothing else in the repo can see a manifest frozen at CLI load.
 *
 * THE HAZARD NEEDS BOTH HALVES IN ONE PROCESS — a load, and a later regeneration
 * — and the two closures are exactly where they can meet:
 *   - STARTUP, because it is in EVERY process, `build`'s included. It is
 *     `bin/index.ts`'s closure with literal dynamic edges followed:
 *     `await import("./cli")`, and `cli.generated.ts`'s loaders, which evaluate
 *     every command's DECLARATION on every invocation (commander needs their
 *     names and flags before it can parse argv). A manifest here is frozen in the
 *     regenerating process too, whichever command that turns out to be.
 *   - A REGENERATING command's run closure, because that body shares its process
 *     with the regeneration. A command whose body never regenerates cannot go
 *     stale — whatever it loads is simply what is on disk, for the whole life of
 *     the process. `deploy converge` loading `fieldsEager` (through the
 *     entity-backed deploy-health handle it reads) is harmless for exactly that
 *     reason, and flagging it would be a rule about a process that does not
 *     exist.
 *
 * WHY `run` EDGES ARE CUT — the CLI contract. A declaration defers its body
 * behind `run: () => import("./run")`, and `bin/register-commands.ts`, the sole
 * caller of `run()`, awaits it only once commander has routed to THAT command:
 * one process runs one command's body. Following every thunk from `bin/index.ts`
 * (as this check once did) measures a process that never exists — every
 * command's body loaded at once — and charged `build` for what only `deploy`
 * imports. The cut is by SHAPE, not by file (`scanCommandRuns`): an
 * `import("<literal>")` that is the whole body of the arrow assigned to `run` in
 * a `defineCliCommand({…})` call. Every other dynamic edge — `./cli`, the
 * registry loaders, the check loaders — is still followed, and a thunk written
 * in any other shape is followed too, so a miss costs a false positive, never a
 * hole.
 *
 * NEITHER THE COMMANDS NOR THE REGENERATORS ARE LISTED. The run closures measured
 * are exactly the thunks the startup measurement cut, so a new command is held to
 * this the moment it is registered. "Regenerates" is read off each closure: a
 * module that CALLS the registry's own writer (`writePreBarrelManifest`, named
 * here through the imported function, so a rename is a type error rather than a
 * silent miss) and is LIVE — kept by the bundler's tree-shaking, i.e. referenced
 * from code that can run. Live, not merely loaded, and that distinction is the
 * whole rule: the codegen barrel re-exports the pipeline, so every command that
 * reads ANY codegen helper loads the regenerating module (`deploy converge`
 * does, through `closure-guards.ts`); only one that can call it is regenerating.
 * On this tree that is `build` (stage 2), `regen-generated`, and `check` — the
 * last conservatively: its closure keeps the whole codegen barrel live, so it is
 * held to the rule without ever regenerating, which costs nothing while its
 * closure is clean. `push` and `normalize-generated` are NOT regenerators: both
 * reach `regen-generated` by spawning it.
 *
 * `release` IS THE PROCESS-ISOLATION CASE, and it measures as designed. It needs
 * stage 2, and its body statically imports plugin barrels (`propagateConfigToUser`
 * via codegen, `symbolBody`, `runAssetMirrorPrewarm`, …), so running
 * the pipeline in-process would be the hazard. It SPAWNS `build --hermetic`
 * instead, so its run closure holds no live writer call and is not a regenerator;
 * the child is a fresh `build` process, held to both rules above in its own
 * right. The same holds for any command that shells out to a regenerating one: a
 * separate process has a separate module cache, so that is not a hole.
 *
 * MEASURED ON WHAT THE RUNTIME LOADS, not on what survives tree-shaking. The
 * manifest test reads `importClosure`'s `modules` (every module the bundler
 * parsed), because Bun's runtime does no tree-shaking: `fieldsEager` is nothing
 * but bare side-effect imports, contributes no code of its own, and so never
 * appears in the tree-shaken set at all — while it is evaluated, and frozen,
 * all the same. (This check previously read the tree-shaken set. Measured alone,
 * `deploy converge`'s tree-shaken set holds neither `fieldsEager` nor the
 * `entities/server` barrel that imports it, while the runtime loads both — and
 * whether a side-effect-only module shows up at all depended on what ELSE the
 * bundle held.)
 *
 * This REPLACES `cli:build-composition-import-subset`, which compared two
 * command files' module sets so that `build-composition` INHERITED the property
 * from `build` rather than re-deriving it. That framing never measured the
 * stated property at all. A frozen BARREL is harmless while everything it
 * reaches is stable; the hazard is its GENERATED INPUTS changing mid-run, which
 * is what this check measures directly.
 *
 * SCOPE, stated rather than left implicit. The registry-phase outputs —
 * `checks/core/check.generated.ts`, `paths/core/data-dirs.generated.ts`,
 * `barrel-import/…/auto-stubs.generated.ts` — ARE loaded by regenerating
 * processes and ARE rewritten in-process by stage 1, i.e. the same mechanism.
 * They are out of scope deliberately: their staleness costs one run of registry
 * content (a missing check or a missing stub — loud, or benign), never the
 * silent deletion of authored data; and they arrive through `paths/server`,
 * `checks/core` and `barrel-import/core`, which the CLI cannot stop importing
 * without losing the ability to run checks or resolve its own data dirs.
 * Reopening that is a separate task, not a hole in this one.
 * `ui/icons/…/symbol-name-list.generated.ts` and `icon-picker/…/symbols-metadata.json`
 * are produced by hand-run scripts, never by a build stage, so no build run can
 * invalidate a frozen copy of them.
 *
 * KNOWN LIMITS, stated rather than papered over: this is a STATIC measurement.
 *   - An `import()` whose specifier is COMPUTED at runtime is invisible to the
 *     bundler, as it is to every static tool. `compositionFleetSource` /
 *     `defaultFleetSource` reach `web-tiers.generated.ts` exactly that way —
 *     harmlessly, because that happens in stage 3, after the config-origins pass
 *     has already run. A hazardous computed-specifier import would pass here, and
 *     so would a regeneration reached only through one.
 *   - "Regenerates" means "calls the registry's writer". A module that wrote a
 *     manifest by some other route — its standalone `generateX` helper, or a
 *     hand-rolled `writeFileSync` — would not mark its command as regenerating.
 *     None does today; the pipeline writes every manifest through the writer.
 *   - In the other direction the check is CONSERVATIVE on purpose, in three ways:
 *     liveness is per MODULE (a module is live if any of its exports is, so the
 *     regenerating pipeline counts whichever of its entry points is referenced);
 *     literal dynamic edges are followed, which pulls every check module into a
 *     regenerating command's closure via `check.generated.ts`'s loaders, so a
 *     CHECK that imported a manifest is flagged even though checks run in stage
 *     3, after the origins pass; and a command's whole run closure counts, not
 *     just what loads before stage 2. That is deliberate — the remedy (read the
 *     manifest's bytes instead of importing it) is cheap and independently right,
 *     so a false positive costs a small correct edit rather than an argument
 *     about phases.
 *
 * `alwaysRun: true` — cheap (~1.3 s: one bundler pass for startup plus one per
 * command body), structural, codegen-coupled, and decisively: the hermetic build
 * path runs stage 2 (and therefore `pruneOrphanedConfigFiles`) while running
 * ONLY the always-run set. A check that guards stage 2 but is skipped whenever
 * stage 2 runs without a full check pass guards nothing. The check this replaces
 * was not `alwaysRun`; that was a gap, not a decision.
 */
const manifestFreezeCheck: Check = {
  id: "cli:codegen-manifests-not-frozen",
  description:
    "no registered pre-barrel or post-web codegen manifest may be loaded by the CLI's startup closure, nor by the run closure of a command that regenerates the manifests in-process — a manifest frozen before stage 2 regenerates it is never re-read, and pruneOrphanedConfigFiles then deletes a freshly-authored config override",
  alwaysRun: true,
  async run() {
    const root = await getWorktreeRoot();

    // repo-relative manifest path -> manifest id, so a hit can name itself.
    const hazards = new Map<string, string>();
    for (const m of [...preBarrelManifests, ...postWebManifests]) {
      hazards.set(relative(root, m.path(root)), m.id);
    }
    // Both lists are non-empty in every tree that has a build pipeline at all,
    // so an empty hazard set means the import above resolved to something that
    // is no longer the manifest registry — and an empty comparison would then
    // report a green derived from measuring nothing. Fail loudly instead.
    if (hazards.size === 0) {
      throw new Error(
        "preBarrelManifests + postWebManifests are EMPTY, so there is nothing to compare the CLI's " +
          "import closures against. That is a broken read of codegen/core (registry moved or renamed?), " +
          "not a repo with no codegen manifests — refusing to report a pass derived from it.",
      );
    }

    const { findings } = await measureManifestFreeze({
      root,
      entry: CLI_ENTRY,
      hazards,
      writer: writePreBarrelManifest.name,
    });
    if (findings.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${findings.length} CLI closure(s) load a codegen manifest that the same process ` +
        `regenerates later, freezing the stale copy:\n` +
        findings.map(describeFreezeFinding).join("\n"),
      hint:
        "Read the manifest's BYTES instead of importing it — `readFileSync` plus the renderer " +
        "exported next to it, which is exactly what the `*-in-sync` checks do — or move the import " +
        "behind a dynamic `import()` with a COMPUTED specifier, which does not execute (and so does " +
        "not freeze) until after stage 2. From the STARTUP closure, moving the import into the " +
        "command's own `run` module is enough — unless that command regenerates. A command that " +
        "needs both the import and a regeneration must run the regeneration in a separate process, " +
        "the way `release` spawns `build --hermetic`. Bun freezes a module on first import() and no " +
        "later disk write invalidates it: stage 2 regenerates these manifests and then imports every " +
        "plugin barrel to collect config_v2 descriptors, so a frozen copy makes generateConfigOrigins " +
        "see the PREVIOUS run's descriptor set and pruneOrphanedConfigFiles delete a freshly-authored " +
        "config override — silent data loss with no failing step. See " +
        "codegen/core/pre-barrel-manifests.ts.",
    };
  },
};

/** One finding as message lines: which closure, which manifests, and how. */
function describeFreezeFinding(f: FreezeFinding): string {
  const head =
    f.closure.kind === "startup"
      ? `  startup closure (${f.closure.entry}) — loaded by EVERY ./equin invocation, ` +
        `the regenerating ones included:`
      : `  run closure of \`${f.closure.commands.join("`, `")}\` (${f.closure.target}) — this ` +
        `process also regenerates the manifests, via ${f.closure.regenerators.join(", ")}:`;
  const body = f.manifests.map(
    (m) =>
      `      ${m.path}  (${m.id})\n        via ${m.chain.join("\n          → ")}`,
  );
  return [head, ...body].join("\n");
}

/**
 * `bin/index.ts` — the CLI's bootstrap — must reach NO npm package through its
 * static import closure.
 *
 * WHY, precisely: `bin/index.ts` is the process that RUNS `bun install`. It arms
 * the orphan guard, `await ensureDeps()`, and only then `await import("./cli.ts")`.
 * Static imports hoist above all of that — an ES module's entire dependency graph
 * is resolved and evaluated BEFORE its first statement executes. So one
 * `import { program } from "commander"` at the top of `bin/index.ts` means a
 * checkout with no `node_modules` dies on an unresolved module before a single
 * line of the bootstrap runs. The CLI can no longer install its own dependencies,
 * and the failure is exactly the shape this whole design exists to eliminate: a
 * pre-CLI death with no subcommand to attribute it to (`./equin check` →
 * exit 1, and the module error names `commander`, not "your deps are missing").
 * `rm -rf node_modules && ./equin build` is then unrecoverable from inside
 * the repo, which is also the fresh-clone path.
 *
 * That is the entire reason the bootstrap / `cli.ts` split exists: today's
 * commander program lives in `bin/cli.ts` precisely so it is reached by a
 * DYNAMIC import, evaluated after the install. Nothing marks `bin/index.ts` as
 * special at the language level, so the split survives only as long as something
 * measures it — the next edit that "just adds an import at the top" silently
 * undoes it.
 *
 * NOT THE WHOLE STORY, and this check must not be read as saying it is. Passing
 * here means nothing resolves BEFORE the install; it says nothing about whether
 * what resolves after it can be found. Bun's resolver caches directory listings,
 * so the installing process cannot see its own `node_modules` — a green check
 * here still ended in `Cannot find package 'commander'` on every fresh checkout
 * until `bin/index.ts` started re-execing after an install. Ordering and process
 * identity are two separate requirements; this check measures the first.
 * `bin/reexec.ts` owns the second.
 *
 * Measured off the same `Bun.build` closure as the check above, from the opposite
 * side: the set of specifiers the resolver declared external IS the set the
 * entrypoint needs `node_modules` for. No independent scanner, and the alias
 * prefixes come from `tsconfig.base.json`, so a new alias cannot turn a repo
 * subtree into a false "npm package" (nor the reverse).
 *
 * Measured with `dynamicImports: "cut"`, which is the whole subtlety. The hazard is
 * HOISTING, so the subject is the static graph only: `bin/index.ts`'s deliberate
 * `await import("./cli.ts")` is a literal specifier the bundler happily follows,
 * and following it would drag `cli.ts`'s entire npm closure (commander, pg, …)
 * into this check's numbers and fail it permanently — while proving nothing, since
 * those packages resolve when that `import()` executes, i.e. after `ensureDeps()`.
 * Cutting the graph at every `import()` edge measures exactly the set that is
 * resolved before the bootstrap's first statement.
 *
 * KNOWN LIMIT, stated rather than papered over: static measurement cannot see an
 * `import()` whose specifier is computed at runtime — nor, by the paragraph above,
 * does this check look inside any dynamic edge at all. So a package reached only
 * that way passes. That is a deliberate scope, not a hole: a dynamic import does
 * not hoist, so it cannot resolve before `ensureDeps()` has run, which is the one
 * failure mode this check exists to prevent. What it does NOT cover is a dynamic
 * import placed *ahead* of `ensureDeps()` in the bootstrap's own control flow —
 * a shape a reader of that deliberately-tiny file can see at a glance, and which
 * no static import-graph measurement can distinguish from a correctly-placed one.
 */
const bootstrapPackageFreeCheck: Check = {
  id: "cli:bootstrap-package-free",
  description:
    "the CLI bootstrap (bin/index.ts) must statically import no npm package — it is the process that RUNS bun install, so its import closure has to resolve with node_modules absent",
  async run() {
    const root = await getWorktreeRoot();
    const { external } = await importClosure(root, BOOTSTRAP, {
      dynamicImports: "cut",
    });

    const offenders = [...external]
      .filter(([spec]) => !resolvesWithoutNodeModules(spec))
      .map(
        ([spec, importers]) =>
          `${spec}  (imported by ${importers.sort().join(", ")})`,
      )
      .sort();
    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${BOOTSTRAP} statically reaches ${offenders.length} specifier(s) that do not resolve ` +
        `without node_modules:\n    ` +
        offenders.join("\n    "),
      hint:
        `Move the import into ${CLI_BODY}, which ${BOOTSTRAP} reaches through a dynamic ` +
        `await import() AFTER ensureDeps() has installed. ${BOOTSTRAP} runs BEFORE bun install, and ` +
        "static imports hoist above every statement in it — so anything it statically imports must " +
        "resolve with node_modules absent: node builtins, relative repo files, and declared " +
        "@plugins/* aliases only. One npm import here turns a fresh checkout (or any `rm -rf " +
        "node_modules`) into an unresolved-module crash before the CLI can install its own " +
        "dependencies.",
    };
  },
};

/**
 * EVERY plugin's `cli/index.ts` is loaded on EVERY `./equin` invocation,
 * so its static import closure must stay data-weight: no npm package, no
 * `web`/`server` barrel.
 *
 * WHY THIS IS THE LOAD-BEARING HALF OF THE WHOLE MECHANISM. Commander needs a
 * command's name, flags and help text before it can parse argv, so there is no
 * way to defer a DECLARATION — `./equin build` pays for every other
 * plugin's declaration, every time. The command's IMPLEMENTATION is the part
 * that must not load, and the declaration defers it through
 * `run: () => import("./run")`. Nothing in the language marks which half is
 * which; a contributor who writes `import { thing } from "./run"` at the top of
 * their declaration to reuse one constant has silently moved their whole command
 * body — and its npm dependencies, and every plugin barrel it reaches — into the
 * hot path of an unrelated command. That edit looks harmless and its cost is
 * invisible, which is exactly the shape that needs a mechanical check rather
 * than a documented convention.
 *
 * The `server` ban is the same rule stated where it bites hardest: a server
 * barrel is the cheapest-looking way for a declaration to reach a real value (an
 * option default like `REPO_ROOT`), and it is also the single heaviest thing in
 * the repo to load — drizzle, pg, the DB pool, the job queue. Resolve such a
 * default inside the action instead, where the import is already deferred.
 *
 * MEASURED WITH `dynamicImports: "cut"`, which is the whole subtlety and the
 * reason this can be a check at all: the declaration's own
 * `run: () => import("./run")` is a literal specifier the bundler would happily
 * follow, and following it would drag in precisely the implementation this check
 * exists to keep out — reporting every correctly-written command as a failure.
 * Cutting at every `import()` edge measures exactly what the CLI pays before it
 * knows which command it is running.
 *
 * The subject list comes from `cli.generated.ts` rather than a filesystem walk,
 * so it is the same set the CLI actually loads. A `cli/index.ts` with no default
 * export is not registered, is not loaded, and is not measured — that is how a
 * shared CLI-machinery barrel (`op-runtime/cli`) sits in the same runtime
 * without being held to a declaration's weight.
 */
const declarationsLightCheck: Check = {
  id: "cli:command-declarations-light",
  description:
    "every plugin's cli/index.ts must reach no npm package and no web/server barrel through its static imports — a command DECLARATION loads on every ./equin invocation, only its implementation is deferred",
  async run() {
    const root = await getWorktreeRoot();
    const { cliEntries } = await import("../core/cli.generated");

    // An empty registry means the collected-dir scan found no command at all,
    // which cannot be true in a tree that has a CLI — every framework command
    // is a contribution. Comparing nothing would report a green derived from a
    // broken read, so fail loudly instead.
    if (cliEntries.length === 0) {
      throw new Error(
        "cli.generated.ts registers NO commands, so there is nothing to measure. That is a broken " +
          "registry read (collected-dir marker moved or renamed?), not a CLI with no commands — " +
          "refusing to report a pass derived from it.",
      );
    }

    const offenders: string[] = [];
    // A stale entry (deleted command) has nothing to measure; the drift itself is
    // `plugins-registry-in-sync`'s to report.
    for (const entry of cliEntries) {
      if (!isCliEntryPresent(root, entry)) continue;
      const rel = cliEntrySourcePath(entry);
      const { modules, external } = await importClosure(root, rel, {
        dynamicImports: "cut",
      });

      const packages = [...external.keys()]
        .filter((spec) => !resolvesWithoutNodeModules(spec))
        .sort();
      // A cross-plugin `@plugins/x/{web,server}` import resolves to that
      // barrel's own file, so the barrels a declaration reaches — directly or
      // transitively — are exactly the runtime barrels in its module set.
      // `modules` is the LOADED set, not the tree-shaken one: a barrel of pure
      // re-exports contributes no code and would vanish from the latter, while
      // the runtime evaluates it (and everything it imports) all the same.
      const barrels = [...modules]
        .filter((m) => /(^|\/)(web|server)\/index\.tsx?$/.test(m))
        .sort();

      if (packages.length === 0 && barrels.length === 0) continue;
      const reasons = [
        ...packages.map((p) => `npm package ${p}`),
        ...barrels.map((b) => `runtime barrel ${b}`),
      ];
      offenders.push(`${rel}\n        ${reasons.join("\n        ")}`);
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${offenders.length} CLI command declaration(s) load more than data on every ` +
        `./equin invocation:\n    ` +
        offenders.join("\n    "),
      hint:
        "Move the import into the module the declaration reaches through `run: () => import(...)`. " +
        "That import is deferred until commander routes to this command; a static import at the top " +
        "of cli/index.ts is paid by EVERY other command, including `build`. For an option default " +
        "that needs a real value, drop the commander default and resolve it inside the action " +
        "(`opts.x ?? THE_VALUE`), stating the default in the option's description.",
    };
  },
};

/**
 * No two plugins may claim the same verb.
 *
 * The failure this prevents is silent, which is why it is worth a check rather
 * than the runtime assertion in `bin/cli.ts` alone: commander keeps whichever
 * command registered first, so the loser's verb is simply absent — its plugin
 * looks installed, its folder is there, and `./equin <verb>` runs someone
 * else's code. `bin/cli.ts` does throw on this, but only for whoever runs the
 * CLI next; catching it in `check` is what stops it reaching main.
 *
 * Loads the declarations for real (they are data by the check above, so this is
 * cheap) rather than parsing names out of source: the name a plugin registers is
 * whatever its module evaluates to, and a check that read the literal would
 * disagree with the CLI the moment one is computed.
 */
const commandNamesUniqueCheck: Check = {
  id: "cli:command-names-unique",
  description:
    "no two plugins may contribute the same ./equin verb — commander keeps the first registration, so a collision silently deletes one plugin's command",
  async run() {
    const root = await getWorktreeRoot();
    const { cliEntries } = await import("../core/cli.generated");

    // pluginPath -> the command names it claims, at each level of the tree.
    const claims = new Map<string, string[]>();
    for (const entry of cliEntries) {
      // Stale entry (deleted command): it claims nothing.
      if (!isCliEntryPresent(root, entry)) continue;
      const mod = (await entry.loader()) as { default?: unknown };
      const exported = mod.default;
      const commands = Array.isArray(exported)
        ? exported
        : exported === undefined
          ? []
          : [exported];
      for (const c of commands) {
        if (!isCliCommand(c)) {
          return {
            ok: false,
            message: `${entry.pluginPath}/cli/index.ts default-exports something that is not a CLI command.`,
            hint: "Declare it with defineCliCommand() from @plugins/framework/plugins/cli/core.",
          };
        }
        for (const path of commandPaths(c)) {
          const owners = claims.get(path) ?? [];
          owners.push(entry.pluginPath);
          claims.set(path, owners);
        }
      }
    }

    const collisions = [...claims]
      .filter(([, owners]) => owners.length > 1)
      .map(
        ([path, owners]) => `${path}  (claimed by ${owners.sort().join(", ")})`,
      )
      .sort();
    if (collisions.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${collisions.length} ./equin verb(s) are claimed by more than one plugin:\n    ` +
        collisions.join("\n    "),
      hint:
        "A verb belongs to exactly one plugin. Rename one of them, or — if both are really the same " +
        "operation — make one a subcommand of the other so the two plugins share a group.",
    };
  },
};

/** Every dotted verb path a command occupies, e.g. `deploy`, `deploy converge`. */
function commandPaths(command: CliCommand, prefix = ""): string[] {
  const path = prefix === "" ? command.name : `${prefix} ${command.name}`;
  if (command.subcommands === undefined) return [path];
  return [path, ...command.subcommands.flatMap((s) => commandPaths(s, path))];
}

export default [
  manifestFreezeCheck,
  bootstrapPackageFreeCheck,
  declarationsLightCheck,
  commandNamesUniqueCheck,
  legacyCliNameCheck,
];
