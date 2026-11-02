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
 *      re-propagate, until stable. That a portable `server/` provider sits in
 *      a `base-exclusions` negative (no desktop boots it) is
 *      `host-services:provider-placement`'s rule, so the provider set read
 *      here is exactly the browser candidates whenever that check passes.
 *
 * One union build over every server barrel, then a reverse BFS over the
 * reversed edges from the modules that need the computer (cycles are fine).
 * `machine/` is out of scope: no browser host boots it.
 */

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  importClosure,
  importClosures,
  loadTypescript,
  type UnionImportClosure,
} from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  findImports,
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
  type HostServiceDecl,
  type ImportRef,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import type TS from "typescript";
import {
  isPlatformApi,
  mayUsePlatformValue,
  platformValueUsesIn,
} from "./platform-apis";

/** A plugin's server barrel, at any nesting depth. */
export const SERVER_BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/server\/index\.ts$/;

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

/**
 * An import that loads its module at runtime: not `import type`, and not an
 * import whose every named binding is `type` (both erase). The same reading the
 * `boundaries/no-platform-api` lint rule makes of one file.
 */
export function loadsAtRuntime(ref: ImportRef): boolean {
  if (ref.typeOnly) return false;
  const named = /^\s*\{([^}]*)\}\s*$/.exec(ref.clause);
  if (named === null) return true;
  const bindings = named[1]!
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b !== "");
  return bindings.length === 0 || !bindings.every((b) => /^type\s/.test(b));
}

/**
 * The platform modules `src` imports and the host-only values it uses (rules 1
 * and 2). The TypeScript pass runs only on a module whose text could hold a
 * use (`mayUsePlatformValue`), so a run over thousands of modules parses the
 * few that might.
 */
export function moduleNeeds(
  ts: typeof TS,
  module: string,
  src: string,
): string[] {
  return [
    ...new Set(
      findImports(src)
        .filter((ref) => loadsAtRuntime(ref) && isPlatformApi(ref.specifier))
        .map((ref) => ref.specifier),
    ),
    ...(mayUsePlatformValue(src) ? platformValueUsesIn(ts, module, src) : []),
  ];
}

/**
 * Rules 1 and 2 over ONE entry's static closure (dynamic imports cut): every
 * module in it that imports a platform API or uses a host-only value, with the
 * chain from the entry. For an arbitrary module — `machine/` files included,
 * which are not server barrels (`boundaries:machine-portable-declaration`).
 * `needs` memoizes each module's reading across calls.
 */
export async function platformOffenders(
  root: string,
  entry: string,
  read: (path: string) => Promise<string | null>,
  needs: Map<string, string[]>,
): Promise<{ modules: number; offenders: Offender[] }> {
  const closure = await importClosure(root, entry, { dynamicImports: "cut" });
  const ts = await loadTypescript();
  const offenders: Offender[] = [];
  for (const module of [...closure.modules].sort()) {
    let found = needs.get(module);
    if (found === undefined) {
      const src = await read(module);
      if (src === null) {
        throw new Error(
          `${entry}'s closure loads ${module}, which the run's file set cannot read.`,
        );
      }
      found = moduleNeeds(ts, module, src);
      needs.set(module, found);
    }
    if (found.length === 0) continue;
    offenders.push({
      module,
      needs: found,
      chain: closure.importChain(module),
    });
  }
  return { modules: closure.modules.size, offenders };
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
  const ts = await loadTypescript();
  const source = async (path: string): Promise<string> => {
    const src = await inputs.read(path);
    if (src === null) {
      throw new Error(
        `The server-barrel closure loads ${path}, which the run's file set cannot read.`,
      );
    }
    return src;
  };

  // Rules 1 and 2, and the host services each module declares.
  const seeds = new Map<string, string[]>();
  const decls: (HostServiceDecl & { module: string })[] = [];
  const modules = [...closure.modules].sort();
  const texts = await Promise.all(modules.map((m) => source(m)));
  // Thousands of modules, some parsed: yield to the event loop every ~10 ms
  // of CPU, so a check pass sharing this thread is not stalled behind the
  // scan (a macrotask, never a microtask — see yieldMacrotask).
  let lastYield = performance.now();
  for (const [i, module] of modules.entries()) {
    if (performance.now() - lastYield > 10) {
      await yieldMacrotask();
      lastYield = performance.now();
    }
    const src = texts[i]!;
    const needs = moduleNeeds(ts, module, src);
    if (needs.length > 0) seeds.set(module, needs);
    if (src.includes("defineHostService")) {
      for (const d of parseHostServiceDeclarations(src))
        decls.push({ ...d, module });
    }
  }
  const byName = hostServicesByName(decls);
  const providers = new Map<string, string[]>();
  for (const barrel of barrels) {
    for (const name of providedServiceNames(await source(barrel))) {
      if (!byName.has(name)) continue;
      providers.set(name, [...(providers.get(name) ?? []), barrel]);
    }
  }

  const parents = new Map<string, string[]>();
  for (const module of modules) {
    for (const child of closure.children(module)) {
      const list = parents.get(child);
      if (list === undefined) parents.set(child, [module]);
      else list.push(module);
    }
  }
  const taintFrom = (from: Iterable<string>): Set<string> => {
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
      // Forward BFS through tainted modules only (every path to a seed runs
      // through them), stopping at each seed: the frontier.
      const own = pluginOf(barrel);
      const parent = new Map<string, string>([[barrel, barrel]]);
      const queue = [barrel];
      const found: Offender[] = [];
      const named = new Set<string>();
      for (const node of queue) {
        const needs = seeds.get(node);
        if (needs !== undefined) {
          const plugin = pluginOf(node);
          if (plugin === own || !named.has(plugin)) {
            named.add(plugin);
            const chain = [node];
            for (let n = node; n !== barrel; n = parent.get(n)!)
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
          `offenders(${barrel}): the barrel is tainted but no module of its closure needs the computer — the taint and the edge walk disagree.`,
        );
      }
      offendersMemo.set(barrel, found);
      return found;
    },
  };
}

/**
 * `barrels`' portability, measured with ONE `Bun.build` over all of them
 * (`importClosures`, dynamic imports cut). Ask {@link serverPortabilityOf}
 * instead, which shares one derivation per repo snapshot.
 */
export async function serverPortability(
  root: string,
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
 * Every server barrel's portability in `repo`, derived once per snapshot: one
 * shared promise per `RepoFiles`, so codegen's consumers (through
 * `buildRegistryGenContext`, a `WeakMap` on the same set) and the checks of
 * one pass share one union build.
 */
export function serverPortabilityOf(
  repo: RepoFiles,
): Promise<ServerPortability> {
  let p = memo.get(repo);
  if (p === undefined) {
    p = serverPortability(
      repo.root,
      repo.all().filter((path) => SERVER_BARREL_RE.test(path)),
      (path) => repo.read(path),
    );
    memo.set(repo, p);
  }
  return p;
}
