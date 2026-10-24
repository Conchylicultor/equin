import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type TS from "typescript";
import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

const TSCONFIG_BASE = "tsconfig.base.json";

// `typescript`'s module object is invariant for the process's lifetime — not a
// tree-derived fact — so a per-process memo is safe. Loaded lazily so this
// module's own top-level import doesn't pay `typescript`'s eval cost on every
// `./equin check` pass (this check module loads during the "load all
// checks" burst, well before any check's `run()` starts). Exported so
// `manifest-freeze.ts` shares this SAME cached promise instead of duplicating
// the import.
let tsPromise: Promise<typeof TS> | undefined;
export function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/**
 * Every path-alias prefix declared in the repo's single alias owner
 * (`tsconfig.base.json` — guaranteed to be the only owner by the
 * `tsconfig-alias-single-owner` check). Derived rather than hardcoded so a new
 * alias never silently becomes an "external package" below and drops a whole
 * subtree out of the measured closure.
 */
function aliasSpecifiers(root: string): {
  prefixes: string[];
  exact: string[];
} {
  const raw = readFileSync(join(root, TSCONFIG_BASE), "utf8");
  const paths = (
    JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, unknown> } }
  ).compilerOptions?.paths;
  if (!paths || Object.keys(paths).length === 0) {
    throw new Error(
      `${TSCONFIG_BASE} declares no path aliases — it is the repo's single alias owner, so this is not a legitimately empty result.`,
    );
  }
  const prefixes: string[] = [];
  const exact: string[] = [];
  for (const key of Object.keys(paths)) {
    if (key.endsWith("*")) prefixes.push(key.slice(0, -1));
    else exact.push(key);
  }
  return { prefixes, exact };
}

/**
 * What a measurement does with an `import()` edge. Required, and a closed set,
 * because the two answers measure different things and neither is a safe
 * default:
 *
 *   - `"cut"` — every `import()` is a traversal BOUNDARY: the specifier is
 *     neither followed nor recorded in `external`. The subject is the STATIC
 *     graph, i.e. what resolves before the entrypoint's first statement runs.
 *     The bootstrap and declaration checks want exactly that: a dynamic edge is
 *     where "must resolve pre-install" / "is paid by every invocation" stops
 *     applying.
 *   - `"follow-except-command-runs"` — every LITERAL `import()` is followed,
 *     except a command declaration's `run` thunk, which is cut and reported in
 *     {@link ImportClosure.commandRuns}. The subject is what ONE CLI PROCESS can
 *     load: `bin/index.ts`'s own `await import("./cli")` and the
 *     `cli.generated.ts` loaders execute on every invocation, so they are
 *     followed; a `run` body executes only when commander routes to THAT
 *     command, so it belongs to that command's process and not to every
 *     process. See {@link scanCommandRuns} for how a `run` edge is told apart
 *     from every other dynamic edge.
 *
 * There is deliberately no "follow everything" policy any more: following every
 * `run` thunk from `bin/index.ts` measures a process that never exists — every
 * command's body loaded at once — and charges `build` for what only `deploy`
 * imports.
 */
export type DynamicImportPolicy = "cut" | "follow-except-command-runs";

/** One `run: () => import("…")` thunk the measurement cut, resolved. */
export interface CommandRunEdge {
  /**
   * The verb path(s) the thunk runs, as typed — `build`, `deploy converge`.
   * Plural only because two leaves may name one module; today none do.
   */
  commands: readonly string[];
  /** The declaration module holding the thunk, repo-relative. */
  declaration: string;
  /** The module the thunk imports, i.e. the command's body, repo-relative. */
  target: string;
}

export interface ImportClosure {
  /**
   * Every REPO module the entrypoint LOADS, as repo-relative paths — recorded
   * by an `onLoad` hook as the bundler parses each one, BEFORE tree-shaking.
   *
   * This is the set the Bun RUNTIME evaluates (it does no tree-shaking: every
   * statically imported module runs), which is why it, and not {@link live},
   * answers "does this process load X". The distinction is not academic:
   * `live` omits every module that contributes no code of its own — a barrel of
   * pure re-exports, or a manifest of bare side-effect imports like
   * `fieldsEager` — and both are evaluated all the same.
   */
  modules: Set<string>;
  /**
   * The subset of {@link modules} that survives tree-shaking — read off the
   * bundle's own external sourcemap (`sources`). A module lands here only when
   * code that can execute references it (or it has top-level side effects), so
   * this answers the OTHER question: "can this process reach code in X", as
   * opposed to merely evaluating X's declarations. The bundler's liveness is a
   * static over-approximation, which is the safe direction for that question.
   *
   * Read off the SINGLE emitted `.map`, which is a complete reading only
   * because `splitting` is off (the default) and there is one entrypoint per
   * build: measured with several entrypoints in one build, each output's
   * `sources` reflects liveness across the WHOLE build, not its own closure
   * (observed: `build`'s run module read 314 live modules alone and 552
   * alongside the other commands). One entrypoint per call is what keeps it
   * honest.
   */
  live: Set<string>;
  /**
   * Every specifier that resolved OUTSIDE the repo tree — i.e. every non-relative,
   * non-alias specifier the `externalize-packages` plugin below declared external
   * — mapped to the repo-relative importers that asked for it.
   *
   * Node/Bun builtins (`node:*`, `bun`, `bun:*`, and the unprefixed builtin
   * names) do NOT appear: Bun resolves those itself, ahead of build plugins, so
   * `onResolve` never sees them. The bootstrap check still classifies them
   * explicitly rather than relying on that — its invariant is "resolvable with no
   * `node_modules`", and it must not silently invert if Bun ever starts routing
   * builtins through plugins.
   */
  external: Map<string, string[]>;
  /**
   * The command `run` thunks cut under `"follow-except-command-runs"`, each
   * resolved to the module it imports. Empty under `"cut"`, which cuts every
   * dynamic edge without classifying it.
   */
  commandRuns: CommandRunEdge[];
  /**
   * The shortest import chain from the entrypoint to `module` (both ends
   * included, repo-relative), for a failure message. Recovered lazily — each
   * edge's specifier is re-resolved only when a chain is asked for — so the
   * green path pays nothing for it. Throws for a module with no chain, which is
   * a caller asking about a module outside {@link modules} or a broken edge
   * record, never a legitimate answer.
   */
  importChain: (module: string) => string[];
}

/**
 * The run thunks and the other `import()` sites of one module, by specifier.
 *
 * `runs` maps a specifier to the verb path(s) whose `run` it is; `other` holds
 * every specifier some NON-run `import()` in the same file also names.
 */
interface CommandRunScan {
  runs: Map<string, string[]>;
  other: Set<string>;
}

const DEFINE_CLI_COMMAND = defineCliCommand.name;

/**
 * Which of a module's `import()` edges are command `run` thunks.
 *
 * A `run` edge is recognised by its SHAPE in the source, not by which file it is
 * in: an `import(<string literal>)` that is the entire body of a parameterless
 * arrow, assigned to the property `run` of the object literal passed to a
 * `defineCliCommand(…)` call. That is the canonical spelling every declaration
 * uses, and it is precisely the value `bin/register-commands.ts` — the sole
 * caller of `run()` — awaits once commander has routed to that command. Nothing
 * else in the tree invokes it: the checks that load declarations
 * (`cli:command-names-unique`, `cli:command-declarations-light`) read `name` and
 * `subcommands` and never call `run`.
 *
 * Every departure is CONSERVATIVE, never a hole. A thunk written any other way
 * (a block body, a wrapper, an aliased `defineCliCommand`) is not recognised, so
 * its edge is followed like any dynamic import and its body is charged to every
 * process that loads the declaration — a false positive at worst. A specifier
 * that ALSO appears in a non-`run` `import()` of the same file is followed too,
 * since `onResolve` cannot tell two same-specifier edges apart.
 *
 * Reads the source rather than the evaluated declaration because the bundler
 * hook sees only `(importer, specifier)`, and because the verb path a thunk
 * belongs to (`deploy converge`) is right there in the enclosing calls' `name`
 * literals. A `name` that is not a string literal is reported as `<computed>`;
 * it only labels the message.
 */
export async function scanCommandRuns(
  file: string,
  source: string,
): Promise<CommandRunScan> {
  const runs = new Map<string, string[]>();
  const other = new Set<string>();
  if (!source.includes(DEFINE_CLI_COMMAND)) return { runs, other };

  const ts = await loadTypescript();
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        const command = runThunkCommand(ts, node);
        if (command === undefined) other.add(arg.text);
        else runs.set(arg.text, [...(runs.get(arg.text) ?? []), command]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { runs, other };
}

/**
 * The verb path whose `run` thunk `importCall` is, or `undefined` when it is
 * not one — see {@link scanCommandRuns} for the recognised shape.
 */
function runThunkCommand(
  ts: typeof TS,
  importCall: TS.CallExpression,
): string | undefined {
  const arrow = importCall.parent;
  if (
    !ts.isArrowFunction(arrow) ||
    arrow.body !== importCall ||
    arrow.parameters.length > 0
  ) {
    return undefined;
  }
  const prop = arrow.parent;
  if (
    !ts.isPropertyAssignment(prop) ||
    prop.initializer !== arrow ||
    propertyName(ts, prop) !== "run"
  ) {
    return undefined;
  }
  if (defineCallOf(ts, prop.parent) === undefined) return undefined;

  // Walk out from the leaf's own object literal through every enclosing
  // `defineCliCommand` (a group's `subcommands`), so a leaf reads as the verb
  // path a user types.
  const names: string[] = [];
  for (let n: TS.Node = prop.parent; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isObjectLiteralExpression(n) && defineCallOf(ts, n) !== undefined) {
      const nameProp = n.properties.find(
        (p): p is TS.PropertyAssignment =>
          ts.isPropertyAssignment(p) && propertyName(ts, p) === "name",
      );
      names.unshift(
        nameProp !== undefined && ts.isStringLiteralLike(nameProp.initializer)
          ? nameProp.initializer.text
          : "<computed>",
      );
    }
  }
  return names.join(" ");
}

/** The `defineCliCommand(obj)` call `obj` is the first argument of, if any. */
function defineCallOf(
  ts: typeof TS,
  obj: TS.Node,
): TS.CallExpression | undefined {
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const call = obj.parent;
  if (
    ts.isCallExpression(call) &&
    call.arguments[0] === obj &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === DEFINE_CLI_COMMAND
  ) {
    return call;
  }
  return undefined;
}

function propertyName(
  ts: typeof TS,
  p: TS.PropertyAssignment,
): string | undefined {
  return ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)
    ? p.name.text
    : undefined;
}

/**
 * The exact set of REPO source modules an entrypoint pulls in (plus the
 * out-of-tree specifiers it reaches for, and — under
 * `"follow-except-command-runs"` — the command bodies it stops at).
 *
 * Measured with `Bun.build` rather than a hand-rolled scanner + resolver: the
 * bundler computes the closure by construction and resolves `@plugins/*` through
 * the on-disk tsconfig exactly as the runtime does, so the answer cannot drift
 * from what actually loads. Two readings come off the one build: the modules the
 * bundler LOADED (an `onLoad` hook that records and returns `undefined`, so the
 * default loader still runs — {@link ImportClosure.modules}) and the modules
 * that SURVIVED tree-shaking (the bundle's own sourcemap —
 * {@link ImportClosure.live}).
 *
 * npm packages are marked external and therefore absent from both. For the
 * manifest-freeze check that is the right scope, not a limitation: its invariant
 * is about REPO-GENERATED files, an npm package can never be one, and bundling
 * `node_modules` for real both fails (playwright's optional peer deps are not
 * installed) and would make the check a package-resolution test. The bootstrap
 * check needs the opposite half of the same measurement, which is why `external`
 * is returned alongside: the set the resolver declared external IS the answer to
 * "what does this entrypoint need `node_modules` for", with no second scanner to
 * keep in sync.
 */
export async function importClosure(
  givenRoot: string,
  entry: string,
  opts: { dynamicImports: DynamicImportPolicy },
): Promise<ImportClosure> {
  // The bundler reports REAL paths (macOS's `/var` is `/private/var`), so a
  // root spelled through a symlink would re-root every module as `../…` and
  // match nothing. Measure against the real spelling.
  const root = realpathSync(givenRoot);
  const { prefixes, exact } = aliasSpecifiers(root);
  const external = new Map<string, string[]>();
  const loaded = new Set<string>();
  const commandRuns: CommandRunEdge[] = [];
  // importer (absolute) -> the in-repo specifiers it asked for, kept only to
  // recover an import chain on failure.
  const edges = new Map<string, Set<string>>();
  const scans = new Map<string, CommandRunScan>();
  const scanOf = async (file: string): Promise<CommandRunScan> => {
    let scan = scans.get(file);
    if (scan === undefined) {
      scan = await scanCommandRuns(file, readFileSync(file, "utf8"));
      scans.set(file, scan);
    }
    return scan;
  };

  const out = mkdtempSync(join(tmpdir(), "cli-import-closure-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: out,
      target: "bun",
      sourcemap: "external",
      plugins: [
        {
          name: "externalize-packages",
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              const spec = args.path;
              if (args.kind === "dynamic-import") {
                // Cut the graph here, whatever the specifier resolves to.
                if (opts.dynamicImports === "cut") {
                  return { path: spec, external: true };
                }
                const scan = await scanOf(args.importer);
                const commands = scan.runs.get(spec);
                if (commands !== undefined && !scan.other.has(spec)) {
                  commandRuns.push({
                    commands,
                    declaration: relative(root, args.importer),
                    target: relative(
                      root,
                      Bun.resolveSync(spec, args.resolveDir),
                    ),
                  });
                  return { path: spec, external: true };
                }
              }
              const inRepo =
                spec.startsWith(".") ||
                spec.startsWith("/") ||
                prefixes.some((p) => spec.startsWith(p)) ||
                exact.includes(spec);
              if (inRepo) {
                // Repo source; let Bun resolve it.
                if (args.importer !== "") {
                  const specs = edges.get(args.importer);
                  if (specs === undefined)
                    edges.set(args.importer, new Set([spec]));
                  else specs.add(spec);
                }
                return undefined;
              }
              const importer =
                args.importer === "" ? entry : relative(root, args.importer);
              const importers = external.get(spec);
              if (importers === undefined) external.set(spec, [importer]);
              else if (!importers.includes(importer)) importers.push(importer);
              return { path: spec, external: true };
            });
            // Record, then fall through to the default loader: the build is
            // unchanged, and every module the bundler parses — tree-shaken or
            // not — is seen exactly once.
            build.onLoad({ filter: /.*/ }, (args) => {
              if (args.namespace === "file") {
                loaded.add(relative(root, args.path));
              }
              return undefined;
            });
          },
        },
      ],
    });
    if (!result.success) {
      throw new Error(
        `Bun.build could not compute the import closure of ${entry}:\n` +
          result.logs.map((l) => `  ${String(l)}`).join("\n"),
      );
    }
    const mapFile = readdirSync(out).find((f) => f.endsWith(".map"));
    if (mapFile === undefined) {
      throw new Error(
        `Bun.build produced no external sourcemap for ${entry}, so the module list is unavailable.`,
      );
    }
    const sources = (
      JSON.parse(readFileSync(join(out, mapFile), "utf8")) as {
        sources: string[];
      }
    ).sources;
    // Sourcemap `sources` are relative to the map file; re-root them on the repo.
    const live = new Set(sources.map((s) => relative(root, resolve(out, s))));
    // An entrypoint always contributes at least itself, so an empty set is
    // never a legitimately-empty measurement — it means a reading is broken
    // (sourcemap shape changed? `onLoad` no longer called?) and every check
    // below would then compare nothing and pass. Likewise the two readings
    // must nest: tree-shaking only removes, so a live module that was never
    // loaded means the `onLoad` record is missing modules. Fail loudly rather
    // than absorb either as a green.
    if (loaded.size === 0 || live.size === 0) {
      throw new Error(
        `Bun.build reported an EMPTY module closure for ${entry} (loaded: ${loaded.size}, live: ` +
          `${live.size}). An entrypoint always contributes itself, so this is a broken measurement, ` +
          `not an entrypoint with no modules — refusing to report a pass derived from it.`,
      );
    }
    const unloaded = [...live].filter((m) => !loaded.has(m));
    if (unloaded.length > 0) {
      throw new Error(
        `Bun.build's sourcemap lists ${unloaded.length} module(s) for ${entry} that its onLoad hook ` +
          `never saw (${unloaded.slice(0, 3).join(", ")}${unloaded.length > 3 ? ", …" : ""}). ` +
          `Tree-shaking only removes, so the loaded set is missing modules — refusing to measure with it.`,
      );
    }

    const importChain = (module: string): string[] => {
      const start = join(root, entry);
      const goal = join(root, module);
      const parent = new Map<string, string>([[start, start]]);
      const queue = [start];
      for (const node of queue) {
        if (parent.has(goal)) break;
        for (const spec of edges.get(node) ?? []) {
          const child = Bun.resolveSync(spec, dirname(node));
          if (parent.has(child)) continue;
          parent.set(child, node);
          queue.push(child);
        }
      }
      // Every module the bundler loaded was reached over an edge recorded
      // above, so a loaded module with no chain means the edge record and the
      // bundler disagree — say so rather than print a message missing its
      // evidence.
      if (!parent.has(goal)) {
        throw new Error(
          `No import chain from ${entry} to ${module} through the recorded edges` +
            (loaded.has(module)
              ? ", although the bundler loaded it — the edge record is incomplete."
              : ": it is not in this closure at all."),
        );
      }
      const chain: string[] = [];
      for (let n = goal; n !== start; n = parent.get(n) ?? start) {
        chain.unshift(relative(root, n));
      }
      chain.unshift(entry);
      return chain;
    };

    return { modules: loaded, live, external, commandRuns, importChain };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
