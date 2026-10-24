// Generic loader for a "collected dir" registry — the build-time counterpart to
// the web/server contribution collection. Every collected runtime (facet, check,
// …) is discovered by codegen into a `<X>.generated.ts` exporting a
// `CollectedEntry[]`; this turns that entry list into validated, typed items.
//
// The caller passes the already-loaded `entries` array (not a module specifier):
// some generated registries must be imported through a non-literal specifier so
// the web bundler cannot statically follow them (see `facets/core/load-facets.ts`),
// and a relative specifier inside this leaf would resolve against the wrong module.
// This leaf has zero cross-plugin imports so `facets/core` and `checks/core` can
// both depend on it without forming an import cycle (`codegen/core`, where the
// `CollectedDir` marker lives, transitively depends on facets and so cannot).

export interface CollectedEntry {
  pluginPath: string;
  id: string;
  loader: () => Promise<{ default: unknown }>;
  dependsOn: string[];
}

export interface LoadCollectedDirOptions<T> {
  /** Type-guard validating each loaded default export (and each item of an array export). */
  isItem: (value: unknown) => value is T;
  /** Topo-sort entries by their `dependsOn` graph before loading (facets need this; checks don't). */
  ordered?: boolean;
  /** De-dupe loaded items by this key, keeping the first occurrence (checks de-dupe by id). */
  dedupeKey?: (item: T) => string;
  /** Label used in warn-on-reject log lines, e.g. "facet" / "check". */
  label?: string;
  /**
   * Treat a rejected loader or an invalid default export as a FAILURE rather
   * than something to warn about and skip. Every failure in the pass is
   * collected and thrown as one error, so a broken tree reports all of its
   * breakage instead of one item per run.
   *
   * Off by default, which is right for facets and checks: a facet that fails to
   * load costs a doc section, and the registry is large enough that one bad
   * contribution should not take the whole pass down.
   *
   * It is WRONG wherever a missing item is indistinguishable from an item that
   * does not exist. `./equin`'s command registry is the case that
   * motivated the option: a `cli/index.ts` that throws at load would otherwise
   * make its verb quietly absent, and `./equin build` would report
   * "unknown command" — a broken deploy pipeline reading as a typo. `lint/` and
   * `provision/` each hand-rolled a fail-loud loader to escape this default;
   * this option exists so the CLI does not become a third copy of that, and so
   * the next fail-loud consumer has something to pass rather than something to
   * rewrite.
   */
  strict?: boolean;
  /**
   * Is this entry's source still on disk? An entry for which this returns false
   * is STALE — a leftover line in a derived registry whose plugin was deleted —
   * and is skipped without being loaded, reported once on stderr, and never
   * counted as a `strict` failure.
   *
   * `strict` answers "present but broken"; this answers "listed but deleted".
   * They must stay apart wherever the registry's own regenerator runs through
   * this loader: `./equin`'s command registry is regenerated only by the
   * CLI, so failing strict on a deleted command meant no `./equin`
   * command could start to regenerate it — `build` and `push` included.
   *
   * Injected rather than checked here so this leaf keeps no `node:*` import.
   */
  isPresent?: (entry: CollectedEntry) => boolean;
}

function topoSort(entries: CollectedEntry[]): CollectedEntry[] {
  const byPath = new Map(entries.map((e) => [e.pluginPath, e]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const result: CollectedEntry[] = [];
  function visit(path: string) {
    if (visited.has(path)) return;
    if (stack.has(path))
      throw new Error(
        `Collected-dir dependency cycle: ${[...stack, path].join(" → ")}`,
      );
    stack.add(path);
    const entry = byPath.get(path);
    if (entry) for (const dep of entry.dependsOn) visit(dep);
    stack.delete(path);
    visited.add(path);
    if (entry) result.push(entry);
  }
  for (const e of entries) visit(e.pluginPath);
  return result;
}

export async function loadCollectedDir<T>(
  entries: CollectedEntry[],
  opts: LoadCollectedDirOptions<T>,
): Promise<T[]> {
  const label = opts.label ?? "collected-dir";
  const present: CollectedEntry[] = [];
  const stale: string[] = [];
  for (const e of entries) {
    if (opts.isPresent && !opts.isPresent(e)) stale.push(e.pluginPath);
    else present.push(e);
  }
  if (stale.length > 0) {
    console.warn(
      `[${label}] registry lists ${stale.length} removed contribution(s), skipped: ` +
        `${stale.join(", ")} — \`./equin build\` regenerates the registry.`,
    );
  }
  const ordered = opts.ordered ? topoSort(present) : present;
  const results = await Promise.allSettled(ordered.map((e) => e.loader()));
  const out: T[] = [];
  const seen = opts.dedupeKey ? new Set<string>() : null;
  // Only populated under `strict`; every failure is collected so one pass
  // reports all of the breakage rather than the first item of it.
  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      if (opts.strict === true) {
        failures.push(
          `${ordered[i]!.pluginPath} — loader threw: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      } else {
        console.warn(`[${label}] failed: ${ordered[i]!.pluginPath}`, r.reason);
      }
      continue;
    }
    const exported = (r.value as { default?: unknown }).default;
    const items = Array.isArray(exported)
      ? exported
      : exported
        ? [exported]
        : [];
    if (opts.strict === true && items.length === 0) {
      failures.push(
        `${ordered[i]!.pluginPath} — no default export (or it is empty)`,
      );
      continue;
    }
    for (const item of items) {
      if (!opts.isItem(item)) {
        if (opts.strict === true) {
          failures.push(
            `${ordered[i]!.pluginPath} — default export is not a valid ${label}`,
          );
        }
        continue;
      }
      if (seen && opts.dedupeKey) {
        const key = opts.dedupeKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(item);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} ${label} contribution(s) failed to load:\n    ` +
        failures.join("\n    "),
    );
  }
  return out;
}
