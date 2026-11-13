import ts from "typescript";
import {
  buildModuleGraph,
  type ModuleGraph,
  type ModuleGraphInput,
} from "@plugins/plugin-meta/plugins/plugin-records/core";

/**
 * How much of a record producer's key is code it never calls.
 *
 * A producer's records are keyed by the Merkle key of its module's WHOLE
 * static+dynamic closure — the only sound key, since importing a barrel
 * evaluates every module it re-exports, and their top-level code (a slot
 * created, a registry filled, `globalThis` patched) can shape what the
 * producer computes. So importing one pure helper from a heavy barrel keys
 * every record on that barrel's closure.
 *
 * This walks the closure a second way, following a pure re-export module (a
 * barrel: imports, exports and types only) only to the modules that define the
 * names the producer imports from it. That walk is NOT sound as a key — it
 * ignores the siblings' top-level effects — but it is exactly the diagnostic:
 * what it leaves out is what the producer keys on without ever calling, and
 * each such module is attributed to the barrel import that drags it in.
 */

const ALL = "all";
type Need = typeof ALL | ReadonlySet<string>;

interface ParsedModule {
  /** Only imports, exports and type declarations: names pass through it. */
  hub: boolean;
  /** Each import (or re-export) of a module of the graph, with the names it takes. */
  imports: { target: string; names: Need }[];
  /** A name this module exports, defined in another module (a namespace: all of it). */
  reexports: Map<string, { target: string; names: Need }>;
  /** `export * from`: a name not found above may come from any of them. */
  stars: string[];
}

export interface BarrelWaste {
  /** The module importing the barrel. */
  importer: string;
  barrel: string;
  /** The value names it takes from the barrel. */
  names: readonly string[];
  /** Modules of the key reached only through this import, not through a name it takes. */
  unused: number;
}

export interface KeyWidth {
  producer: string;
  /** The modules its key covers: its static+dynamic closure. */
  keyed: number;
  /** Those it can call: reached through the names it imports. */
  used: number;
  /** The keyed modules it never calls, sorted. */
  unused: readonly string[];
  /** The barrel imports the unused modules come through, widest first. */
  barrels: readonly BarrelWaste[];
}

function parseModule(
  graph: ModuleGraph,
  path: string,
  src: string,
): ParsedModule {
  const node = graph.modules.get(path)!;
  const deps = new Set([...node.staticDeps, ...node.dynamicDeps]);
  // The graph's own resolution of each specifier: this walk never resolves one.
  const targetOf = new Map(
    [...node.staticImports, ...node.dynamicImports].map((i) => [
      i.spec,
      i.target,
    ]),
  );
  const resolveIn = (spec: string): string | null => targetOf.get(spec) ?? null;
  const sf = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    false,
    /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: ParsedModule = {
    hub: true,
    imports: [],
    reexports: new Map(),
    stars: [],
  };
  const reached = new Set<string>();
  const local = new Map<string, { target: string; names: Need }>();
  const specOf = (e: ts.Expression): string => (e as ts.StringLiteral).text;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const target = resolveIn(specOf(st.moduleSpecifier));
      if (target === null) continue;
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      reached.add(target);
      let names: Need = new Set<string>();
      if (!clause || clause.name) names = ALL;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        names = ALL;
        local.set(bindings.name.text, { target, names: ALL });
      }
      if (bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue;
          const name = (el.propertyName ?? el.name).text;
          local.set(el.name.text, { target, names: new Set([name]) });
          if (names !== ALL) (names as Set<string>).add(name);
        }
      if (names === ALL || names.size > 0) out.imports.push({ target, names });
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (!st.moduleSpecifier) {
        if (st.exportClause && ts.isNamedExports(st.exportClause))
          for (const el of st.exportClause.elements) {
            const from = local.get((el.propertyName ?? el.name).text);
            if (from && !el.isTypeOnly) out.reexports.set(el.name.text, from);
          }
        continue;
      }
      const target = resolveIn(specOf(st.moduleSpecifier));
      if (target === null) continue;
      reached.add(target);
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements)
          if (!el.isTypeOnly)
            out.reexports.set(el.name.text, {
              target,
              names: new Set([(el.propertyName ?? el.name).text]),
            });
      } else if (st.exportClause && ts.isNamespaceExport(st.exportClause)) {
        out.reexports.set(st.exportClause.name.text, { target, names: ALL });
      } else out.stars.push(target);
    } else if (
      !ts.isTypeAliasDeclaration(st) &&
      !ts.isInterfaceDeclaration(st) &&
      !ts.isExportAssignment(st)
    ) {
      out.hub = false;
    }
  }
  // What the declarations above did not account for (a `require`, a dynamic
  // `import()`) is taken whole: the diagnostic must not under-count what runs.
  for (const d of deps)
    if (!reached.has(d)) out.imports.push({ target: d, names: ALL });
  return out;
}

function closureOf(graph: ModuleGraph, from: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length > 0) {
    const m = stack.pop()!;
    if (seen.has(m)) continue;
    seen.add(m);
    const n = graph.modules.get(m)!;
    stack.push(...n.staticDeps, ...n.dynamicDeps);
  }
  return seen;
}

/** The key width of each of `producers` (repo-relative modules). */
export async function keyWidths(
  input: ModuleGraphInput,
  producers: readonly string[],
): Promise<KeyWidth[]> {
  const graph = await buildModuleGraph(input, producers);
  const parsed = new Map<string, Promise<ParsedModule>>();
  const parse = (path: string): Promise<ParsedModule> => {
    let p = parsed.get(path);
    if (!p)
      parsed.set(
        path,
        (p = input.snapshot.read(path).then((src) => {
          if (src === null)
            throw new Error(`[key-width] cannot read module ${path}`);
          return parseModule(graph, path, src);
        })),
      );
    return p;
  };

  const out: KeyWidth[] = [];
  for (const producer of producers) {
    const taken = new Map<string, Need>();
    const barrelEdges: { importer: string; barrel: string; names: Need }[] = [];
    const queue: [string, Need][] = [[producer, ALL]];
    while (queue.length > 0) {
      const [m, asked] = queue.pop()!;
      const mod = await parse(m);
      const need: Need = mod.hub ? asked : ALL;
      const prev = taken.get(m);
      if (prev === ALL) continue;
      let fresh: Need;
      if (need === ALL) fresh = ALL;
      else {
        fresh = new Set([...need].filter((n) => !prev?.has(n)));
        if (fresh.size === 0) continue;
      }
      taken.set(
        m,
        need === ALL
          ? ALL
          : new Set([...(prev ?? []), ...(need as Set<string>)]),
      );
      const names = fresh === ALL ? null : fresh;
      if (names === null) {
        for (const i of mod.imports) {
          queue.push([i.target, i.names]);
          barrelEdges.push({ importer: m, barrel: i.target, names: i.names });
        }
        for (const r of mod.reexports.values()) queue.push([r.target, r.names]);
        for (const s of mod.stars) queue.push([s, ALL]);
        continue;
      }
      for (const n of names) {
        const r = mod.reexports.get(n);
        if (r) queue.push([r.target, r.names]);
        else if (n === "default")
          for (const i of mod.imports) queue.push([i.target, i.names]);
        else for (const s of mod.stars) queue.push([s, new Set([n])]);
      }
    }

    const keyed = closureOf(graph, [producer]);
    const used = new Set(taken.keys());
    const unused = [...keyed].filter((m) => !used.has(m)).sort();
    const barrels: BarrelWaste[] = [];
    const seenEdges = new Set<string>();
    for (const e of barrelEdges) {
      if (e.names === ALL || !(await parse(e.barrel)).hub) continue;
      const edge = `${e.importer}\0${e.barrel}`;
      if (seenEdges.has(edge)) continue;
      seenEdges.add(edge);
      let n = 0;
      for (const m of closureOf(graph, [e.barrel])) if (!used.has(m)) n++;
      if (n > 0)
        barrels.push({
          importer: e.importer,
          barrel: e.barrel,
          names: [...e.names].sort(),
          unused: n,
        });
    }
    barrels.sort((a, b) => b.unused - a.unused);
    out.push({
      producer,
      keyed: keyed.size,
      used: used.size,
      unused,
      barrels,
    });
  }
  return out;
}

/**
 * The most modules a producer's key may cover that it never calls. Measured
 * 2026-11-05 over every producer: the honest ones keep under 20 (a barrel's
 * few unused siblings); the three that a barrel import widened kept 37 (the
 * structure facet, via a path constant), 39 (the facet harness, via barrel
 * evaluation) and 205 (the cross-refs facet, via a one-line var-name helper).
 *
 * A producer over it is fixed, never this bound raised (see plugin-records'
 * CLAUDE.md for the only reason it may move).
 */
export const MAX_UNUSED_KEY_MODULES = 20;

/** The failure text for the producers over {@link MAX_UNUSED_KEY_MODULES}, or null. */
export function describeWideKeys(widths: readonly KeyWidth[]): string | null {
  const wide = widths.filter((w) => w.unused.length > MAX_UNUSED_KEY_MODULES);
  if (wide.length === 0) return null;
  const lines = wide.map((w) => {
    const edges = w.barrels
      .slice(0, 3)
      .map(
        (b) =>
          `    ${b.importer} takes { ${b.names.join(", ")} } from ${b.barrel}: +${b.unused} modules it never calls`,
      );
    return [
      `  ${w.producer}: keyed by ${w.keyed} modules, calls ${w.used} — ${w.unused.length} unused (max ${MAX_UNUSED_KEY_MODULES})`,
      ...edges,
    ].join("\n");
  });
  return [
    "A record producer's key covers code it never calls: every edit to those modules re-keys (and recomputes) every record it made.",
    ...lines,
    "Fix the producer, never the bound: move what it takes into a leaf it can import alone (a child plugin with no heavy imports — e.g. boundaries/runtime-exception, closure/entry-pattern, theme-engine/token-var-name), or read it from the producer's own input instead of a module. Raising MAX_UNUSED_KEY_MODULES to pass would keep every record re-keyed by code the producer never calls.",
  ].join("\n");
}
