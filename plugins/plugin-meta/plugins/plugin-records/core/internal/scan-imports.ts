/**
 * A module's imports as the Bun runtime sees them — through Bun's own
 * transpiler, so the module graph's edges are exactly the ones a barrel
 * import evaluates: `import type …` and all-`type` binding lists are erased,
 * an import used only in a type position is NOT (Bun keeps it, and so loads
 * the module), and `require("…")` loads with its importer.
 */

export interface ImportSpec {
  spec: string;
  /** `import("…")`: code the module can load later, not with it. */
  dynamic: boolean;
  /**
   * A bundler drops it: a TypeScript import none of whose bindings the module
   * uses as a value. The runtime still loads it; a bundle (`Bun.build`, a
   * browser host's artifacts) does not.
   */
  unused?: true;
}

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
};
const transpilers = new Map<string, Bun.Transpiler>();

function transpiler(
  loader: "ts" | "tsx" | "js" | "jsx",
  trim: boolean,
): Bun.Transpiler {
  const key = `${loader}:${trim}`;
  let t = transpilers.get(key);
  if (!t)
    transpilers.set(
      key,
      (t = new Bun.Transpiler({ loader, trimUnusedImports: trim })),
    );
  return t;
}

export function scanModuleImports(src: string, path: string): ImportSpec[] {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  const loader = LOADERS[ext];
  if (loader === undefined)
    throw new Error(`[plugin-records] ${path} is not a script module`);
  // A hashbang line (`#!/usr/bin/env bun`, an executable entry point) is
  // legal at the start of a module for the runtime and the bundler, but the
  // transpiler's scan rejects it; it holds no import either way.
  const code = src.startsWith("#!") ? src.replace(/^#![^\n]*/, "") : src;
  let all: ReturnType<Bun.Transpiler["scanImports"]>;
  let kept: ReturnType<Bun.Transpiler["scanImports"]>;
  try {
    all = transpiler(loader, false).scanImports(code);
    kept = transpiler(loader, true).scanImports(code);
  } catch (err) {
    throw new Error(`[plugin-records] cannot scan the imports of ${path}`, {
      cause: err,
    });
  }
  const bundled = new Set(kept.map((i) => `${i.kind}\0${i.path}`));
  return all.map((i) => ({
    spec: i.path,
    dynamic: i.kind === "dynamic-import",
    ...(bundled.has(`${i.kind}\0${i.path}`) ? {} : { unused: true as const }),
  }));
}
