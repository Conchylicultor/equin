// Shared discovery + loading of per-plugin `vite/index.ts` build contributions
// (Babel plugins the artifact builder runs, each on the modules its
// `appliesTo` accepts — web-artifacts' `babel-transform.ts`). Originally extracted from
// `web-core/vite.config.ts` so the per-plugin artifact builder
// (`tooling/web-artifacts`) reused the EXACT same transform set as the
// monolithic build; that build is gone, so web-artifacts is now the sole
// consumer — one discovery walk, one ordering rule, still the single owner of
// the ordering contract each `vite/index.ts` contribution is written against.
//
// Imported through the `@plugins/framework/plugins/web-core/core` barrel.

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import type react from "@vitejs/plugin-react";

// Each `vite/index.ts` contribution returns a Babel plugin. We derive the exact
// item type from `@vitejs/plugin-react`'s own options rather than importing it
// from `@babel/core` directly (its types don't resolve from this file's location,
// though react's bundled `.d.ts` resolves them internally). `Exclude<…, fn>` drops
// the function form of `babel`, leaving the object form whose `plugins` is the
// `PluginItem[]` react ultimately expects.
type ReactBabelObject = Exclude<
  NonNullable<NonNullable<Parameters<typeof react>[0]>["babel"]>,
  (...args: never[]) => unknown
>;
export type BabelPluginItem = NonNullable<ReactBabelObject["plugins"]>[number];

// A contribution's default export returns a `BabelContribution`:
//
// - `order` is the ONLY ordering knob the consumer reads — it never names an
//   individual contributor (collection-consumer separation). Lower `order` runs
//   FIRST in Babel's plugin list; omitted means `0`. Convention: reserve a low
//   value like `-100` for "must run first" transforms (e.g. a whole-program
//   compiler that other JSX-stamping transforms must follow).
// - `appliesTo` says which files the plugin can change. A file no contribution
//   applies to never goes through Babel (a whole parse + regenerate of a file
//   the plugins would hand back as is — about half the shipped bytes, and the
//   biggest single cost of a cold artifact build). It must be exact in one
//   direction: false only for a file the plugin would leave unchanged. Required,
//   so a new contribution cannot silently run on everything.
export interface BabelContribution {
  order?: number;
  plugin: BabelPluginItem;
  appliesTo: (source: BabelSource) => boolean;
}

/** One module as the builder hands it to `appliesTo`: its id (path, maybe a `?query`) and its code. */
export interface BabelSource {
  id: string;
  code: string;
}

/** The loaded contributions, in run order (ascending `order`, stable). */
export type OrderedBabelContributions = ReadonlyArray<
  Required<Pick<BabelContribution, "order">> & BabelContribution
>;

/**
 * Discover every plugin's `vite/index.ts` build contribution generically — never
 * naming an individual contributor (collection-consumer separation). Each such
 * module default-exports a factory `({ repoRoot }) => babelPlugin`. Presence of
 * a `vite/` folder == presence of its transform: drop the contributing plugin
 * and the walk finds nothing. Returned paths are sorted for determinism.
 *
 * A plain `readdir` walk rather than `fs/promises.glob`, to avoid that API's
 * Node-version floor. Async, one directory at a time (a concurrent walk would
 * hold a directory handle per folder in the tree at once): the web-artifacts
 * builder identity runs this inside a check pass, where a blocking walk of the
 * whole plugin tree held the check runner's shared thread for 2–5 s.
 */
export async function findViteContributions(
  pluginsRoot: string,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "ENOTDIR")
        throw err;
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name.startsWith("dist.")
      ) {
        continue;
      }
      if (e.name === "vite") {
        const index = path.join(dir, e.name, "index.ts");
        if (await isFile(index)) out.push(index);
        continue;
      }
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(pluginsRoot, 0);
  out.sort();
  return out;
}

/** Whether `file` exists (the sync walk's `existsSync`, without blocking). */
async function isFile(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Load every discovered contribution and return them in run order. STABLE-sorts
 * ascending by `order` so the list is deterministic regardless of filesystem
 * discovery order — ordering is load-bearing for transforms that REQUIRE a
 * relative position (e.g. a whole-program compiler that must precede
 * JSX-stamping transforms). Contributions are imported by ABSOLUTE path, so the
 * `@plugins` alias (which the esbuild config loader does not resolve) is never
 * needed.
 */
export async function loadBabelContributions(opts: {
  pluginsRoot: string;
  repoRoot: string;
}): Promise<OrderedBabelContributions> {
  const ordered: Array<
    Required<Pick<BabelContribution, "order">> & BabelContribution
  > = [];
  for (const file of await findViteContributions(opts.pluginsRoot)) {
    const mod = (await import(file)) as {
      default: (o: { repoRoot: string }) => BabelContribution;
    };
    const ret = mod.default({ repoRoot: opts.repoRoot });
    if (typeof ret?.appliesTo !== "function") {
      throw new Error(
        `${file}: a vite/ contribution must return { plugin, appliesTo, order? } — appliesTo is missing`,
      );
    }
    ordered.push({ ...ret, order: ret.order ?? 0 });
  }
  ordered.sort((a, b) => a.order - b.order);
  return ordered;
}

/** The Babel plugins that apply to one module, in run order (empty: leave it to oxc). */
export function babelPluginsFor(
  contributions: OrderedBabelContributions,
  source: BabelSource,
): BabelPluginItem[] {
  return contributions.filter((c) => c.appliesTo(source)).map((c) => c.plugin);
}
