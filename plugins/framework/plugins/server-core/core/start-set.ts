import {
  isMachineNode,
  machineNode,
} from "@plugins/framework/plugins/plugin-id/core";
import type { ServerRegistryEntry } from "./boot-stages";

// ── Which plugins a process starts ───────────────────────────────────────────
//
// A process that runs ONE piece of work (a job) starts from one plugin — the
// one that declared the work — and the contributed lists the work reads. This
// is the one rule that turns that into the set of plugins to start
// (research: "Design: one rule for what each process and page starts",
// 2026-11-19):
//
//   1. the starting plugin, and every plugin its `dependsOn` reaches;
//   2. a plugin starts WHOLE: the machine half of every server half in the
//      set (importing any part of a plugin already starts its server code, so
//      "the other half ran" stays true by construction);
//   3. every contributor of a list the work reads, with 1–2 applied to it;
//   4. the provider of every host service the set declares, the handler of
//      every report sink it declares (`sinkHandlers`: a report emitted with
//      no handler is held and lost at exit; a request sink only when declared
//      `alwaysHandled`, since any other's emitter is told nobody answered), and the contributors of every kind
//      opened to companions it defines (what its owner needs at run time) —
//      which only loading the set can tell, so the caller loops.
//
// Each member carries the reason it is there, so "why is this loaded?" is one
// lookup. Pure: the generated plugin list and the build's contributor table
// in, a set out. The caller loads it (`runExec`'s partial start), and the list
// rule (`declarePartialStart`) guards every list it did not ask for.

/** A graph node: a server half's `pluginPath`, a machine half's `<pluginPath>#machine`. */
export function graphNodeOf(entry: ServerRegistryEntry): string {
  return isMachineNode(entry.id)
    ? machineNode(entry.pluginPath)
    : entry.pluginPath;
}

/**
 * The build's table of who contributes to which list: a contribution kind's
 * debug name → the graph nodes whose barrels contribute to it
 * (`contributors.generated.ts`). Covers every plugin of the repo; a node not
 * in this process's registry is not part of its composition and is ignored.
 */
export type ContributorTable = Readonly<Record<string, readonly string[]>>;

/** The host-service provider contributions' kind prefix (`defineHostService`). */
const HOST_SERVICE_KIND = "host-service:";

/** A sink's handlers' key in the table (`sinkHandlers`, the generator's `sink:`). */
const SINK_HANDLER_KEY = "sink:";

export interface StartSetInput {
  /** This process's registry, both halves. */
  readonly entries: readonly ServerRegistryEntry[];
  /** The starting plugins, as `pluginPath`s (`database/plugins/fork`). */
  readonly roots: readonly string[];
  /** The contribution kinds (debug names) the work reads whole. */
  readonly reads: readonly string[];
  /** Host services the set declares with no provider in it yet. */
  readonly hostServices?: readonly string[];
  /** Report sinks the set declares (`defineReportSink(id)`): their handlers start. */
  readonly sinks?: readonly string[];
  readonly contributors: ContributorTable;
  /** Follow a `dependsOn` edge to this node? Default: every edge. */
  readonly follow?: (node: string) => boolean;
}

export interface StartSet {
  /** The entries to start, in registry order. */
  readonly entries: ServerRegistryEntry[];
  /** Node → why it is in the set ("root", "imported by x", …). */
  readonly why: ReadonlyMap<string, string>;
}

/** The plugins a process starting from `roots` and reading `reads` starts. */
export function resolveStartSet(input: StartSetInput): StartSet {
  const byNode = new Map(input.entries.map((e) => [graphNodeOf(e), e]));
  const follow = input.follow ?? (() => true);
  const why = new Map<string, string>();
  const close = (seeds: readonly (readonly [string, string])[]): void => {
    const queue = [...seeds];
    while (queue.length > 0) {
      const [node, reason] = queue.pop()!;
      if (why.has(node)) continue;
      const entry = byNode.get(node);
      if (entry === undefined) {
        throw new Error(
          `[start-set] "${node}" (${reason}) is not in this process's plugin registry.`,
        );
      }
      why.set(node, reason);
      for (const dep of entry.dependsOn) {
        if (follow(dep)) queue.push([dep, `imported by ${node}`]);
      }
      if (!isMachineNode(entry.id)) {
        const machine = machineNode(entry.pluginPath);
        if (byNode.has(machine) && follow(machine))
          queue.push([machine, `machine half of ${node}`]);
      }
    }
  };
  // A root is a plugin: its server half, or its machine half when it has
  // only that one (step 2 brings the machine half of a server half anyway).
  close(
    input.roots.map((r) => {
      const node = byNode.has(r) ? r : machineNode(r);
      if (!byNode.has(node)) {
        throw new Error(
          `[start-set] the starting plugin "${r}" has no server or machine half in this process's plugin registry.`,
        );
      }
      return [node, "root"] as const;
    }),
  );
  // A contributor outside this registry is outside this composition: it is
  // started nowhere here, and the list rule ignores it the same way.
  const inRegistry = (nodes: readonly string[] | undefined) =>
    (nodes ?? []).filter((n) => byNode.has(n));
  for (const kind of input.reads) {
    close(
      inRegistry(input.contributors[kind]).map(
        (n) => [n, `contributes ${kind}`] as const,
      ),
    );
  }
  for (const sink of input.sinks ?? []) {
    close(
      inRegistry(input.contributors[`${SINK_HANDLER_KEY}${sink}`]).map(
        (n) => [n, `handles sink ${sink}`] as const,
      ),
    );
  }
  for (const service of input.hostServices ?? []) {
    const providers = inRegistry(
      input.contributors[`${HOST_SERVICE_KIND}${service}`],
    );
    if (providers.length !== 1) {
      throw new Error(
        `[start-set] host service "${service}" has ${providers.length} providers in this registry (${providers.join(", ") || "none"}); a process starts exactly one.`,
      );
    }
    close([[providers[0]!, `provides ${service}`]]);
  }
  return {
    entries: input.entries.filter((e) => why.has(graphNodeOf(e))),
    why,
  };
}

/**
 * The contributors of `kind` in `registry` that `started` does not hold — what
 * the list rule names when a complete list is read in a partial process.
 */
export function missingContributors(
  contributors: ContributorTable,
  kind: string,
  registry: ReadonlySet<string>,
  started: ReadonlySet<string>,
): string[] {
  return (contributors[kind] ?? []).filter(
    (n) => registry.has(n) && !started.has(n),
  );
}
