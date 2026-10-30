import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type TS from "typescript";
import { parsedTsSource } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import {
  importClosure,
  loadTypescript,
  type ImportClosure,
} from "@plugins/framework/plugins/tooling/plugins/import-closure/core";

/** How many module reads one measurement holds open at once. */
const READ_CONCURRENCY = 32;

export interface ManifestFreezeInput {
  root: string;
  /** The CLI's one entrypoint, repo-relative (`bin/index.ts`). */
  entry: string;
  /** Repo-relative manifest path → manifest id, so a hit can name itself. */
  hazards: ReadonlyMap<string, string>;
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
  const { root, entry, hazards, writer } = input;
  const policy = { dynamicImports: "follow-except-command-runs" } as const;

  const startup = await importClosure(root, entry, policy);
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
            .run(() => readFile(join(root, module), "utf8"))
            .then((source) => callsFunction(module, source, writer))
        : Promise.resolve(false);
      callers.set(module, hit);
    }
    return hit;
  };

  // Sequential on purpose: each `Bun.build` already fans out across cores, and
  // running ~20 of them at once holds every closure's parse in memory together
  // for no gain in wall time.
  const runs: {
    target: string;
    commands: string[];
    closure: ImportClosure;
    regenerators: string[];
  }[] = [];
  for (const [target, commands] of byTarget) {
    const closure = await importClosure(root, target, policy);
    const liveModules = [...closure.live];
    const hits = await Promise.all(liveModules.map((m) => callsWriter(m)));
    runs.push({
      target,
      commands: [...new Set(commands)].sort(),
      closure,
      regenerators: liveModules.filter((_, i) => hits[i]).sort(),
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

  const frozen = (closure: ImportClosure): FrozenManifest[] =>
    [...hazards]
      .filter(([path]) => closure.modules.has(path))
      .map(([path, id]) => ({ path, id, chain: closure.importChain(path) }))
      .sort((a, b) => a.path.localeCompare(b.path));

  const findings: FreezeFinding[] = [];
  const atStartup = frozen(startup);
  if (atStartup.length > 0) {
    findings.push({
      closure: { kind: "startup", entry },
      manifests: atStartup,
    });
  }
  for (const run of regeneratingRuns) {
    const manifests = frozen(run.closure);
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
