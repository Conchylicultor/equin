/**
 * Whether a server barrel can run on a host without the computer (a page's
 * Web Worker) — a FACT derived from its static import closure, never a claim
 * a plugin writes. Every reader asks {@link serverPortabilityOf}: the
 * browser-host derivation (codegen), its coverage guard's messages,
 * `host-services:provider-placement` and `boundaries:portable-own-barrels`.
 *
 * A barrel is portable iff no module its static closure loads (dynamic
 * imports cut; the bundler's own resolution, `importClosures`) needs the
 * computer. A module needs it in one of three ways:
 *
 *   1. it imports a platform API at runtime (`isPlatformApi`, read the way
 *      {@link loadsAtRuntime} reads an import);
 *   2. it uses a host-only value (`platformValueUsesIn`: `Buffer`, `process`,
 *      an unguarded `.unref()`, …);
 *   3. it declares a host service that no portable `server/` barrel provides —
 *      a service only `machine/` provides is a computer-only API reached
 *      through a seam. Whether a provider is portable depends on this same
 *      taint, so rule 3 is a monotone fixpoint: import taint first, then the
 *      declaring modules of services left without an untainted provider, then
 *      re-propagate, until stable. A `server/` barrel that provides a service
 *      is a host provider, which no composition bundles
 *      (`EdgeGraph.hostProviders`), so the portable providers read here are
 *      exactly a browser host's candidates.
 *
 * One union build over every server barrel, then a reverse BFS over the
 * reversed edges from the modules that need the computer (cycles are fine).
 * `machine/` is out of scope: no browser host boots it.
 */

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  importClosures,
  loadTypescript,
  type UnionImportClosure,
} from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  hostServicesByName,
  type HostServiceDecl,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import {
  fileSetClosure,
  scanFilesCached,
  type BundledClosure,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  factsOf,
  SERVER_BARREL_RE,
  type ModulePortabilityFacts,
} from "./portability-facts";

/** One closure module that needs the computer, with the chain to it. */
export interface Offender {
  module: string;
  /**
   * What it needs: platform modules it imports, host-only values it uses
   * (`global Buffer`, `unguarded .unref()`), host services no portable
   * `server/` barrel provides.
   */
  needs: string[];
  /** The shortest import chain from the barrel to `module`, both ends included. */
  chain: string[];
}

/** Every server barrel's portability, derived from one union closure. */
export interface ServerPortability {
  /** Every server barrel measured, sorted. */
  barrels: readonly string[];
  /** Whether `barrel`'s closure needs nothing of the computer. Throws for a barrel not measured. */
  isPortable(barrel: string): boolean;
  /**
   * Why `barrel` is not portable: the modules of its closure that need the
   * computer, each with what it needs and the shortest chain from the barrel.
   * A frontier (an offender reached only through another is not named),
   * pruned to one per plugin outside the barrel's own. Throws for a portable
   * barrel — there is nothing to explain.
   */
  offenders(barrel: string): Offender[];
}

/** The plugin (`plugins/a/plugins/b`) a repo path sits in, or the path itself outside one. */
function pluginOf(path: string): string {
  const m = /^(plugins\/[^/]+(?:\/plugins\/[^/]+)*)\/(?!plugins\/)[^/]+\//.exec(
    path,
  );
  return m === null ? path : m[1]!;
}

/** What {@link derivePortability} reads: the union closure, and the run's file reads. */
export interface PortabilityInputs {
  /** The server barrels measured. */
  barrels: readonly string[];
  /** Their union closure (dynamic imports cut). */
  closure: Pick<UnionImportClosure, "modules" | "children" | "importChain">;
  read(path: string): Promise<string | null>;
  /**
   * Each module's facts, in order — by default read and computed here; the
   * build hands its file records (`serverPortabilityOf`).
   */
  facts?(modules: readonly string[]): Promise<ModulePortabilityFacts[]>;
}

/** The default {@link PortabilityInputs.facts}: every module read and scanned, yielding as it goes. */
function readFacts(
  read: (path: string) => Promise<string | null>,
): (modules: readonly string[]) => Promise<ModulePortabilityFacts[]> {
  return async (modules) => {
    const ts = await loadTypescript();
    const texts = await Promise.all(
      modules.map(async (m) => {
        const src = await read(m);
        if (src === null) {
          throw new Error(
            `The server-barrel closure loads ${m}, which the run's file set cannot read.`,
          );
        }
        return src;
      }),
    );
    // Thousands of modules, some parsed: yield to the event loop every ~10 ms
    // of CPU, so a check pass sharing this thread is not stalled behind the
    // scan (a macrotask, never a microtask — see yieldMacrotask).
    let lastYield = performance.now();
    const out: ModulePortabilityFacts[] = [];
    for (const [i, module] of modules.entries()) {
      if (performance.now() - lastYield > 10) {
        await yieldMacrotask();
        lastYield = performance.now();
      }
      out.push(factsOf(ts, module, texts[i]!));
    }
    return out;
  };
}

/**
 * The derivation over an already-measured closure — split from
 * {@link serverPortability} so a test can hand it a fixture tree's closure.
 */
export async function derivePortability(
  inputs: PortabilityInputs,
): Promise<ServerPortability> {
  const { closure } = inputs;
  const barrels = [...inputs.barrels].sort();
  // Rules 1 and 2, and the host services each module declares.
  const seeds = new Map<string, string[]>();
  const decls: (HostServiceDecl & { module: string })[] = [];
  const modules = [...closure.modules].sort();
  const facts = await (inputs.facts ?? readFacts(inputs.read))(modules);
  const factsByModule = new Map<string, ModulePortabilityFacts>();
  for (const [i, module] of modules.entries()) {
    const f = facts[i]!;
    factsByModule.set(module, f);
    if (f.needs.length > 0) seeds.set(module, f.needs);
    for (const d of f.decls) decls.push({ ...d, module });
  }
  const byName = hostServicesByName(decls);
  const providers = new Map<string, string[]>();
  for (const barrel of barrels) {
    const provided = factsByModule.get(barrel);
    if (!provided)
      throw new Error(`${barrel} is not in the server-barrel closure.`);
    for (const name of provided.provides) {
      if (!byName.has(name)) continue;
      providers.set(name, [...(providers.get(name) ?? []), barrel]);
    }
  }

  const taintFrom = reverseTaint(closure, modules);

  // Rule 3, to a fixpoint: taint only grows, so it terminates.
  let tainted = taintFrom(seeds.keys());
  for (;;) {
    let grew = false;
    for (const d of [...byName.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const need = `host service "${d.id}", which no portable \`server/\` barrel provides`;
      if ((seeds.get(d.module) ?? []).includes(need)) continue;
      if ((providers.get(d.name) ?? []).some((p) => !tainted.has(p))) continue;
      seeds.set(d.module, [...(seeds.get(d.module) ?? []), need]);
      grew = true;
    }
    if (!grew) break;
    tainted = taintFrom(seeds.keys());
  }

  const measured = new Set(barrels);
  const assertMeasured = (barrel: string): void => {
    if (!measured.has(barrel)) {
      throw new Error(
        `${barrel} is not one of the ${barrels.length} server barrels measured — portability is derived for server barrels only.`,
      );
    }
  };
  const offendersMemo = new Map<string, Offender[]>();
  return {
    barrels,
    isPortable(barrel) {
      assertMeasured(barrel);
      return !tainted.has(barrel);
    },
    offenders(barrel) {
      assertMeasured(barrel);
      const memo = offendersMemo.get(barrel);
      if (memo !== undefined) return memo;
      if (!tainted.has(barrel)) {
        throw new Error(
          `offenders(${barrel}): it is portable — nothing in its closure needs the computer.`,
        );
      }
      const found = frontierOffenders(closure, seeds, tainted, barrel);
      offendersMemo.set(barrel, found);
      return found;
    },
  };
}

/**
 * Every module of `modules` that reaches one of `from` (included), walking
 * the closure's edges backwards — cycles are fine.
 */
function reverseTaint(
  closure: Pick<UnionImportClosure, "children">,
  modules: readonly string[],
): (from: Iterable<string>) => Set<string> {
  const parents = new Map<string, string[]>();
  for (const module of modules) {
    for (const child of closure.children(module)) {
      const list = parents.get(child);
      if (list === undefined) parents.set(child, [module]);
      else list.push(module);
    }
  }
  return (from) => {
    const tainted = new Set(from);
    const queue = [...tainted];
    for (const node of queue) {
      for (const parent of parents.get(node) ?? []) {
        if (tainted.has(parent)) continue;
        tainted.add(parent);
        queue.push(parent);
      }
    }
    return tainted;
  };
}

/**
 * Why tainted `entry` needs the computer: a forward BFS through tainted
 * modules only (every path to a seed runs through them), stopping at each
 * seed — the frontier, pruned to one offender per plugin outside the entry's
 * own, each with the shortest chain from `entry`. Never empty.
 */
function frontierOffenders(
  closure: Pick<UnionImportClosure, "children">,
  seeds: ReadonlyMap<string, string[]>,
  tainted: ReadonlySet<string>,
  entry: string,
): Offender[] {
  const own = pluginOf(entry);
  const parent = new Map<string, string>([[entry, entry]]);
  const queue = [entry];
  const found: Offender[] = [];
  const named = new Set<string>();
  for (const node of queue) {
    const needs = seeds.get(node);
    if (needs !== undefined) {
      const plugin = pluginOf(node);
      if (plugin === own || !named.has(plugin)) {
        named.add(plugin);
        const chain = [node];
        for (let n = node; n !== entry; n = parent.get(n)!)
          chain.unshift(parent.get(n)!);
        found.push({ module: node, needs, chain });
      }
      continue;
    }
    for (const child of closure.children(node)) {
      if (parent.has(child) || !tainted.has(child)) continue;
      parent.set(child, node);
      queue.push(child);
    }
  }
  if (found.length === 0) {
    throw new Error(
      `offenders(${entry}): it is tainted but no module of its closure needs the computer — the taint and the edge walk disagree.`,
    );
  }
  return found;
}

/** Rules 1 and 2 over a union closure, for arbitrary entrypoints. */
export interface PlatformTaint {
  /** Whether `module`'s closure needs the computer (rules 1 and 2). Throws for a module outside the closure. */
  needsComputer(module: string): boolean;
  /** Why it does — {@link frontierOffenders}. Throws for a module that does not. */
  offenders(module: string): Offender[];
}

/**
 * Rules 1 and 2 (no host services: rule 3 is a server-barrel question) over
 * an already-measured union closure — every module that imports a platform
 * API or uses a host-only value, propagated to every module that loads one.
 * Each module's facts are read and computed here unless `facts` hands them
 * in (as {@link platformTaintOf} does, from their file records).
 */
export async function platformTaint(
  closure: Pick<UnionImportClosure, "modules" | "children">,
  read: (path: string) => Promise<string | null>,
  facts: (
    modules: readonly string[],
  ) => Promise<ModulePortabilityFacts[]> = readFacts(read),
): Promise<PlatformTaint> {
  const modules = [...closure.modules].sort();
  const seeds = new Map<string, string[]>();
  for (const [i, f] of (await facts(modules)).entries()) {
    if (f.needs.length > 0) seeds.set(modules[i]!, f.needs);
  }
  const tainted = reverseTaint(closure, modules)(seeds.keys());
  const assertIn = (module: string): void => {
    if (!closure.modules.has(module)) {
      throw new Error(`${module} is not in the measured closure.`);
    }
  };
  return {
    needsComputer(module) {
      assertIn(module);
      return tainted.has(module);
    },
    offenders(module) {
      assertIn(module);
      if (!tainted.has(module)) {
        throw new Error(
          `offenders(${module}): nothing in its closure needs the computer.`,
        );
      }
      return frontierOffenders(closure, seeds, tainted, module);
    },
  };
}

/**
 * Rules 1 and 2 over the static closure of `entries` in `repo` (dynamic
 * imports cut): what `boundaries:web-loads-portable` asks of the modules a
 * browser realm loads, and `boundaries:machine-portable-declaration` of one
 * declaring module. The closure is the module graph's bundler view and each
 * module's facts its file record ({@link measuredClosure}), so a pass after an
 * edit reads and scans the edited modules alone — never a `Bun.build` of the
 * closure, never a re-read of it.
 */
export async function platformTaintOf(
  repo: RepoFiles,
  entries: readonly string[],
): Promise<PlatformTaint> {
  const { closure, facts } = await measuredClosure(repo, entries);
  return platformTaint(closure, (path) => repo.read(path), facts);
}

/**
 * The bundler's static closure of `entries` over `repo` (plugin-records'
 * `fileSetClosure`: one module graph per file set, shared with codegen), and
 * the portability facts of its modules as file records.
 */
async function measuredClosure(
  repo: RepoFiles,
  entries: readonly string[],
): Promise<{
  closure: BundledClosure;
  facts: (modules: readonly string[]) => Promise<ModulePortabilityFacts[]>;
}> {
  const { closure, input } = await fileSetClosure(repo, entries);
  return {
    closure,
    facts: async (modules) => {
      const { PORTABILITY_FACTS_SCAN } =
        await import("./portability-facts.scan");
      return scanFilesCached(input, modules, PORTABILITY_FACTS_SCAN);
    },
  };
}

/**
 * `barrels`' portability, measured with ONE `Bun.build` over all of them
 * (`importClosures`, dynamic imports cut). Ask {@link serverPortabilityOf}
 * instead, which shares one derivation per repo snapshot.
 */
export async function serverPortability(
  root: AppPath,
  barrels: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<ServerPortability> {
  const closure = await importClosures(root, [...barrels].sort(), {
    dynamicImports: "cut",
  });
  return derivePortability({ barrels, closure, read });
}

const memo = new WeakMap<RepoFiles, Promise<ServerPortability>>();

/**
 * Every server barrel's portability in `repo`, derived once per file set: one
 * shared promise per `RepoFiles`, so codegen's consumers (through
 * `buildRegistryGenContext`, a `WeakMap` on the same set) and the checks of
 * one pass share one derivation.
 *
 * The closure is the plugin-records module graph's BUNDLER view (dynamic
 * imports cut, unused TypeScript imports dropped — what `importClosures`
 * measures, proven equal by `plugin-records/scripts/closure-equivalence.ts`),
 * and each module's facts are file records: from the build's snapshot, only a
 * module whose blob changed is read.
 */
export function serverPortabilityOf(
  repo: RepoFiles,
): Promise<ServerPortability> {
  let p = memo.get(repo);
  if (p === undefined) {
    p = (async () => {
      const barrels = repo
        .all()
        .filter((path) => SERVER_BARREL_RE.test(path))
        .sort();
      const { closure, facts } = await measuredClosure(repo, barrels);
      return derivePortability({
        barrels,
        closure,
        read: (path) => repo.read(path),
        facts,
      });
    })();
    memo.set(repo, p);
  }
  return p;
}
