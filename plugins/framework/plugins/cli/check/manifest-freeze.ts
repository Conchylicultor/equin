import type TS from "typescript";
import { parsedTsSource } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  closureRecord,
  gitBlobId,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  fileSetImportClosures,
  importClosure,
  loadTypescript,
  type FileSetImportClosure,
} from "@plugins/framework/plugins/tooling/plugins/import-closure/core";

/** The repo's single alias owner, which `Bun.build` resolves every alias through. */
const TSCONFIG_BASE = "tsconfig.base.json";

/** How many module reads one measurement holds open at once. */
const READ_CONCURRENCY = 32;

export interface ManifestFreezeInput {
  /** The checkout's file set: every closure is read off its module graph. */
  repo: RepoFiles;
  /** The CLI's one entrypoint, repo-relative (`bin/index.ts`). */
  entry: string;
  /** Repo-relative manifest path → manifest id, so a hit can name itself. */
  hazards: ReadonlyMap<string, string>;
  /**
   * Repo-relative stage-1 registry path (`<dir>.generated.ts`) → its collected
   * dir. Measured on what a process EVALUATES AT LOAD — see
   * {@link measureManifestFreeze} — not on everything it can load.
   */
  registries: ReadonlyMap<string, string>;
  /**
   * The modules every invocation evaluates before routing, besides the
   * command declarations (which are read off the startup measurement):
   * `bin/index.ts` and the `bin/cli.ts` it imports.
   */
  startupRoots: readonly string[];
  /**
   * The name of the function the manifest registry writes a manifest through.
   * A module that CALLS it is regenerating code; see {@link callsFunction}.
   */
  writer: string;
}

/** Which process a finding is about. */
export type FreezeClosure =
  /** What EVERY `./equin` invocation loads, whatever the verb. */
  | { kind: "startup"; entry: string }
  /** One command's body, in a process that also regenerates the manifests. */
  | {
      kind: "command-run";
      commands: readonly string[];
      target: string;
      /** The live modules in this closure that call the registry's writer. */
      regenerators: readonly string[];
    };

export interface FrozenManifest {
  path: string;
  id: string;
  /**
   * `manifest`: a pre-barrel / post-web manifest anywhere in the closure.
   * `registry`: a stage-1 registry evaluated at load.
   */
  hazard: "manifest" | "registry";
  /** Entrypoint → … → manifest, repo-relative. */
  chain: readonly string[];
}

export interface FreezeFinding {
  closure: FreezeClosure;
  manifests: FrozenManifest[];
}

export interface ManifestFreezeReport {
  findings: FreezeFinding[];
  /**
   * The command bodies bundled this pass (their recorded regenerators missed),
   * sorted — every other one was a lookup.
   */
  bundled: string[];
  /**
   * Every verb path whose run closure regenerates in-process, sorted — the set
   * the per-command rule was applied to. Never empty (see
   * {@link measureManifestFreeze}).
   */
  regenerating: string[];
}

/**
 * Measure the two closures in which a loaded manifest can go stale — the
 * startup closure, and the run closure of every command that regenerates — and
 * report every registered manifest either one loads.
 *
 * The commands are not listed anywhere: the run closures measured are exactly
 * the `run` thunks the startup measurement cut (so a new command is measured
 * the moment it is registered), and "regenerates" is read off each closure —
 * a LIVE module that calls `writer`. The whole rule and its limits are stated
 * on the check that calls this, `cli:codegen-manifests-not-frozen`.
 *
 * Two loud failures instead of a green derived from measuring nothing: a
 * startup closure that cut NO run thunk (the thunk recogniser, or the command
 * registry, no longer matches the tree), and a tree in which NO command
 * regenerates (the writer was renamed or bypassed, so the per-command rule
 * would hold nobody to it — while `build` plainly still regenerates).
 */
export async function measureManifestFreeze(
  input: ManifestFreezeInput,
): Promise<ManifestFreezeReport> {
  const { repo, entry, hazards, registries, startupRoots, writer } = input;
  const policy = { dynamicImports: "follow-except-command-runs" } as const;

  const startup = await fileSetImportClosures(repo, [entry], policy);
  if (startup.commandRuns.length === 0) {
    throw new Error(
      `The startup closure of ${entry} cut NO command \`run\` thunk, so there is no command body to ` +
        "measure. Every leaf command declares `run: () => import(…)`, so this is a broken " +
        "measurement (thunk shape changed? command registry not reached?), not a CLI with no " +
        "commands — refusing to report a pass derived from it.",
    );
  }

  // One measurement per distinct command body, labelled with every verb that
  // runs it.
  const byTarget = new Map<string, string[]>();
  for (const edge of startup.commandRuns) {
    byTarget.set(edge.target, [
      ...(byTarget.get(edge.target) ?? []),
      ...edge.commands,
    ]);
  }

  // One answer per module, read asynchronously through a bounded gate: a
  // closure lists hundreds of modules, and a blocking read of each held the
  // thread every check shares.
  const callers = new Map<string, Promise<boolean>>();
  const reads = createSemaphore(READ_CONCURRENCY);
  const callsWriter = (module: string): Promise<boolean> => {
    let hit = callers.get(module);
    if (hit === undefined) {
      hit = /\.[cm]?[jt]sx?$/.test(module)
        ? reads
            .run(() => repo.read(module))
            .then((source) => {
              if (source === null)
                throw new Error(
                  `${module} is in a command's bundle but not readable from the checkout's file set`,
                );
              return callsFunction(module, source, writer);
            })
        : Promise.resolve(false);
      callers.set(module, hit);
    }
    return hit;
  };

  // Which LIVE modules of a command body call the writer — the bundle's
  // tree-shaking, which no module graph answers — is recorded per body, keyed
  // on exactly what its `Bun.build` parses (`bundled`: each module of its
  // closure by content and edges) and on the code computing it (this module,
  // read from the checkout it runs from — never from the set measured).
  // So a pass bundles only the bodies whose closure an edit reaches; an edit
  // outside every one (a web plugin) bundles none.
  //
  // Sequential on purpose: each `Bun.build` already fans out across cores, and
  // running ~40 of them at once holds every closure's parse in memory together
  // for no gain in wall time.
  const tsconfigText = await repo.read(TSCONFIG_BASE);
  if (tsconfigText === null)
    throw new Error(
      `${TSCONFIG_BASE} is not in the checkout's file set: the bundler resolves every alias through it`,
    );
  const tsconfigBlob = gitBlobId(tsconfigText);
  const bundled: string[] = [];
  const runs: {
    target: string;
    commands: string[];
    closure: FileSetImportClosure;
    regenerators: string[];
  }[] = [];
  for (const [target, commands] of byTarget) {
    const closure = await fileSetImportClosures(repo, [target], policy);
    const recorded = await closureRecord<string[], never>(
      repo,
      {
        name: "cli:manifest-freeze-regenerators",
        code: [import.meta.url],
        bundled: closure,
        // The bundler also reads the alias owner (its `paths`, its compiler
        // options) — an input no module of the closure names.
        input: { target, writer, tsconfig: tsconfigBlob },
      },
      async () => {
        bundled.push(target);
        const built = await importClosure(repo.root, target, policy);
        // The record is keyed on the graph's closure; it may stand for the
        // build's answer only when the build parsed exactly that.
        const graphOnly = [...closure.modules].filter(
          (m) => !built.modules.has(m),
        );
        const buildOnly = [...built.modules].filter(
          (m) => !closure.modules.has(m),
        );
        if (graphOnly.length > 0 || buildOnly.length > 0) {
          throw new Error(
            `The module graph and Bun.build disagree on what ${target} loads ` +
              `(graph only: ${graphOnly.slice(0, 3).join(", ") || "none"}; ` +
              `build only: ${buildOnly.slice(0, 3).join(", ") || "none"}) — a record keyed on the ` +
              "graph's closure would not cover what the build read, so refusing to record it.",
          );
        }
        const liveModules = [...built.live];
        const hits = await Promise.all(liveModules.map((m) => callsWriter(m)));
        return {
          ok: true,
          value: liveModules.filter((_, i) => hits[i]).sort(),
        };
      },
    );
    if (!recorded.ok)
      throw new Error(`recording ${target}'s regenerators failed`);
    runs.push({
      target,
      commands: [...new Set(commands)].sort(),
      closure,
      regenerators: recorded.value,
    });
  }

  const regeneratingRuns = runs.filter((r) => r.regenerators.length > 0);
  if (regeneratingRuns.length === 0) {
    throw new Error(
      `No command's run closure reaches live code that calls \`${writer}\`, so the per-command ` +
        "rule would hold no command to anything. `build` regenerates every manifest in-process, so " +
        "this is a broken derivation (writer renamed, or the pipeline no longer writes through " +
        "it?), not a CLI in which nothing regenerates — refusing to report a pass derived from it.",
    );
  }

  const hits = (
    set: ReadonlyMap<string, string>,
    hazard: FrozenManifest["hazard"],
    closure: FileSetImportClosure,
  ): FrozenManifest[] =>
    [...set]
      .filter(([path]) => closure.modules.has(path))
      .map(([path, id]) => ({
        path,
        id,
        hazard,
        chain: closure.importChain(path),
      }));
  const byPath = (a: FrozenManifest, b: FrozenManifest): number =>
    a.path.localeCompare(b.path);

  // Registries are written by stage 1, the FIRST thing a regenerating command
  // does, so a registry is frozen only when it is evaluated before the command
  // body's first statement: in the static (dynamic-cut) closure of what the
  // process evaluates at load. A literal `import()` inside a reader runs after
  // stage 1 and reads what it wrote — which is why the manifests' "anywhere in
  // the closure" reading would be wrong here (every registry is reached by
  // some reader's `import()`, and the registry of commands is evaluated at
  // startup by design).
  const atLoad = (entries: readonly string[]): Promise<FileSetImportClosure> =>
    fileSetImportClosures(repo, entries, { dynamicImports: "cut" });
  const declarations = [
    ...new Set(startup.commandRuns.map((e) => e.declaration)),
  ];

  const findings: FreezeFinding[] = [];
  const atStartup = [
    ...hits(hazards, "manifest", startup),
    ...hits(
      registries,
      "registry",
      await atLoad([...startupRoots, ...declarations]),
    ),
  ].sort(byPath);
  if (atStartup.length > 0) {
    findings.push({
      closure: { kind: "startup", entry },
      manifests: atStartup,
    });
  }
  for (const run of regeneratingRuns) {
    const manifests = [
      ...hits(hazards, "manifest", run.closure),
      ...hits(registries, "registry", await atLoad([run.target])),
    ].sort(byPath);
    if (manifests.length === 0) continue;
    findings.push({
      closure: {
        kind: "command-run",
        commands: run.commands,
        target: run.target,
        regenerators: run.regenerators,
      },
      manifests,
    });
  }

  return {
    findings,
    bundled: bundled.sort(),
    regenerating: regeneratingRuns.flatMap((r) => r.commands).sort(),
  };
}

/**
 * Whether `source` contains a CALL to a function named `name` — as a bare
 * identifier or as a property (`codegen.name(…)`). A declaration, an import, a
 * re-export and a mention in a comment or string are not calls, which is the
 * whole point of parsing rather than grepping: the registry module that DEFINES
 * the writer, and the barrel that re-exports it, are loaded by every reader of
 * the manifest list and must not read as regenerating.
 */
export async function callsFunction(
  file: string,
  source: string,
  name: string,
): Promise<boolean> {
  if (!source.includes(name)) return false;
  const ts = await loadTypescript();
  // The kind (TS / TSX) follows `file`'s extension.
  const sf = await parsedTsSource(ts, { rel: file, src: source });
  let found = false;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === name) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === name)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
