/**
 * Sizes what a job process would start if it started only what its job needs,
 * against what it starts today (the whole registry).
 *
 *   ./equin run plugins/framework/plugins/server-core/scripts/measure-job-slice.ts \
 *     --root database/plugins/fork \
 *     [--reads fork-data-exclusion,fork-schema-data-exclusion] [--runs 3] [--why <node>]
 *
 * `--root` is a plugin path as the registry spells it (`pluginPath` in
 * `core/server.generated.ts`); `--reads` the debug names of the contribution
 * kinds the job reads (`defineServerContribution("<name>")`).
 *
 * The slice, in graph nodes (`x` a server half, `x#machine` a machine half):
 *
 *   1. the root, and every node its `dependsOn` reaches;
 *   2. a plugin starts whole: the machine half of every plugin in the slice;
 *   3. every contributor of a kind in `--reads`, with 1–2 applied to it;
 *   4. the provider of every host service the slice's modules declare — found
 *      by loading the slice and asking, to a fixpoint.
 *
 * It loads modules only (`loadServerPlugins`): no contribution collect, no
 * `register`, no `onReadyBlocking`, no database. Each load runs in a child
 * process of its own, so module caches do not leak between measurements, and
 * reports its own CPU time — the figure that holds on a loaded machine, where
 * wall time does not. Measures the main composition's committed registries.
 */
import { spawnSync } from "node:child_process";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  isMachineNode,
  machineNode,
} from "@plugins/framework/plugins/plugin-id/core";
import { loadServerPlugins } from "../core/boot-stages";
import type { ServerRegistryEntry } from "../core/boot-stages";
import { declaredHostServiceIds } from "../core/host-service";
import { serverEntries } from "../core/server.generated";
import { machineEntries } from "../core/machine.generated";

const HOST_SERVICE_KIND = "host-service:";

/** A registry entry's graph node: its machine half is `<pluginPath>#machine`. */
function nodeOf(entry: ServerRegistryEntry): string {
  return isMachineNode(entry.id)
    ? machineNode(entry.pluginPath)
    : entry.pluginPath;
}

const entries: ServerRegistryEntry[] = [...serverEntries, ...machineEntries];
const byNode = new Map(entries.map((e) => [nodeOf(e), e]));

function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1] !== undefined)
      out.push(...process.argv[i + 1]!.split(","));
  }
  return out;
}

// ── Child: load a node set, report what it cost and what it declares ────────

interface ChildReport {
  nodes: number;
  cpuMs: number;
  wallMs: number;
  /** Contribution kind (debug name) → the nodes contributing to it. */
  contributors: Record<string, string[]>;
  /** Host services the loaded modules declare with no provider among them. */
  unprovided: string[];
}

async function child(nodes: string[] | "all"): Promise<void> {
  // Modules resolve namespace-scoped paths at module eval; nothing here writes.
  declareRuntimeNamespace(asNamespace(argValues("--namespace")[0] ?? "equin"));
  const picked =
    nodes === "all" ? entries : nodes.map((n) => byNode.get(n)!);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const loaded = await loadServerPlugins(picked);
  const cpu = process.cpuUsage(cpu0);
  const wallMs = performance.now() - t0;

  const contributors: Record<string, string[]> = {};
  loaded.forEach((plugin) => {
    for (const c of plugin.contributions ?? []) {
      const kind = c._kind.description ?? "(unnamed)";
      (contributors[kind] ??= []).push(String(plugin.id));
    }
  });
  const provided = new Set(
    Object.keys(contributors)
      .filter((k) => k.startsWith(HOST_SERVICE_KIND))
      .map((k) => k.slice(HOST_SERVICE_KIND.length)),
  );
  const report: ChildReport = {
    nodes: loaded.length,
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    contributors,
    unprovided: declaredHostServiceIds().filter((id) => !provided.has(id)),
  };
  // The last line of stdout is the report; a module may print while loading.
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  process.exit(0);
}

function runChild(nodes: string[] | "all"): ChildReport {
  const result = spawnSync(
    process.execPath,
    [
      import.meta.path,
      "--child",
      nodes === "all" ? "all" : JSON.stringify(nodes),
      ...process.argv.slice(2),
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `measure-job-slice: child load failed (exit ${String(result.status)}):\n${result.stderr}`,
    );
  }
  const last = result.stdout.trimEnd().split("\n").at(-1)!;
  return JSON.parse(last) as ChildReport;
}

// ── Parent: build the slice, measure both ───────────────────────────────────

/** Loaded plugin ids are dotted; the registry maps them back to graph nodes. */
const nodeById = new Map(entries.map((e) => [e.id, nodeOf(e)]));

/** `from` → why each reached node is in the slice (the node that brought it). */
function close(seeds: Map<string, string>, into: Map<string, string>): void {
  const queue = [...seeds];
  while (queue.length > 0) {
    const [node, why] = queue.pop()!;
    if (into.has(node)) continue;
    const entry = byNode.get(node);
    if (entry === undefined) continue; // a dep the main composition does not hold
    into.set(node, why);
    for (const dep of entry.dependsOn) queue.push([dep, `imported by ${node}`]);
    // A plugin starts whole: its machine half comes with its server half.
    if (!isMachineNode(entry.id)) {
      const machine = machineNode(entry.pluginPath);
      if (byNode.has(machine)) queue.push([machine, `machine half of ${node}`]);
    }
  }
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function main(): void {
  const roots = argValues("--root");
  if (roots.length === 0) {
    throw new Error(
      "measure-job-slice: usage: --root <pluginPath> [--reads <kind>,…] [--runs N] [--why <node>]",
    );
  }
  for (const root of roots) {
    if (!byNode.has(root))
      throw new Error(`measure-job-slice: no registry entry for "${root}".`);
  }
  const reads = argValues("--reads");
  const runs = Number(argValues("--runs")[0] ?? "3");

  const fullRuns = Array.from({ length: runs }, () => runChild("all"));
  const full = fullRuns[0]!;

  const slice = new Map<string, string>();
  close(new Map(roots.map((r) => [r, "root"])), slice);
  const closureOnly = slice.size;

  for (const kind of reads) {
    const contributors = full.contributors[kind];
    if (contributors === undefined) {
      throw new Error(
        `measure-job-slice: no plugin contributes to "${kind}". Kinds: ${Object.keys(full.contributors).sort().join(", ")}`,
      );
    }
    close(
      new Map(
        contributors.map((id) => [nodeById.get(id)!, `contributes ${kind}`]),
      ),
      slice,
    );
  }
  const withReads = slice.size;

  // Host-service providers, to a fixpoint: a provider's own modules may
  // declare further services.
  let sliceReport = runChild([...slice.keys()]);
  while (sliceReport.unprovided.length > 0) {
    for (const service of sliceReport.unprovided) {
      const providers = full.contributors[`${HOST_SERVICE_KIND}${service}`];
      if (providers === undefined || providers.length !== 1) {
        throw new Error(
          `measure-job-slice: host service "${service}" has ${String(providers?.length ?? 0)} providers in the full graph.`,
        );
      }
      close(
        new Map([[nodeById.get(providers[0]!)!, `provides ${service}`]]),
        slice,
      );
    }
    sliceReport = runChild([...slice.keys()]);
  }
  const sliceRuns = [
    sliceReport,
    ...Array.from({ length: runs - 1 }, () => runChild([...slice.keys()])),
  ];

  const fmt = (r: ChildReport[]) =>
    `${String(r[0]!.nodes).padStart(4)} nodes · CPU ${median(r.map((x) => x.cpuMs)).toFixed(0)} ms · wall ${median(r.map((x) => x.wallMs)).toFixed(0)} ms (median of ${String(r.length)})`;
  console.log(`root(s): ${roots.join(", ")}`);
  console.log(`reads:   ${reads.length === 0 ? "(none)" : reads.join(", ")}`);
  console.log(`today  (whole registry): ${fmt(fullRuns)}`);
  console.log(`slice  (what it needs):  ${fmt(sliceRuns)}`);
  console.log(
    `  imports + whole plugins: ${String(closureOnly)} nodes · + list contributors: ${String(withReads)} · + service providers: ${String(slice.size)}`,
  );
  const reasons = new Map<string, number>();
  for (const why of slice.values()) {
    const key = why.replace(/ (by|of) .*/, "");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.log(
    `  by reason: ${[...reasons].map(([k, n]) => `${k} ${String(n)}`).join(" · ")}`,
  );
  for (const node of argValues("--why")) {
    const chain: string[] = [];
    let at: string | undefined = node;
    while (at !== undefined && slice.has(at)) {
      const why: string = slice.get(at)!;
      chain.push(`${at} ← ${why}`);
      at = /(?:by|of) (.+)$/.exec(why)?.[1];
    }
    console.log(
      chain.length === 0
        ? `  why ${node}: not in the slice`
        : `  why ${node}:\n    ${chain.join("\n    ")}`,
    );
  }
}

const childAt = process.argv.indexOf("--child");
if (childAt === -1) {
  main();
} else {
  const arg = process.argv[childAt + 1]!;
  await child(arg === "all" ? "all" : (JSON.parse(arg) as string[]));
}
