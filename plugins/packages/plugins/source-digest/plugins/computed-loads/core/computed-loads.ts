// How source-digest reads one module's loads — its transpiler per extension,
// and the `import(…)` / `require(…)` calls Bun's import scan does not report
// (their path is not a literal). A leaf with no imports: the digest's walk and
// `boot:closure-digestable`'s file scan share it, so the guard and the digest
// cannot disagree on what counts, and the scan's records are keyed by this
// module alone.

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Whether `path` is a module source the digest scans (`.ts`, `.tsx`, `.js`, …). */
export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path);
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
};

/** The transpiler that reads `path` the way Bun loads it. */
export function transpilerFor(path: string): Bun.Transpiler {
  if (path.endsWith(".tsx")) return transpilers.tsx;
  if (path.endsWith(".jsx")) return transpilers.jsx;
  if (/\.[cm]?ts$/.test(path)) return transpilers.ts;
  return transpilers.js;
}

// A call that loads a module at runtime: `import(…)` / `require(…)`.
const DYNAMIC_LOAD = /\b(import|require)\s*\(/g;
// The same, as a stateless probe (a global regex's `test` moves the
// `lastIndex` a later `matchAll` would start from).
const HAS_DYNAMIC_LOAD = /\b(?:import|require)\s*\(/;

/** A module's loads the digest cannot follow, by kind. */
export interface ComputedLoads {
  import: number;
  require: number;
}

/** How many `import(…)` / `require(…)` calls of `text` the scan did not report. */
export function unseenLoads(
  transpiler: Bun.Transpiler,
  text: string,
  imports: readonly { kind: string }[],
): ComputedLoads {
  // Most files hold no such call at all: no need to transpile them twice.
  if (!HAS_DYNAMIC_LOAD.test(text)) return { import: 0, require: 0 };
  const calls = { import: 0, require: 0 };
  for (const m of transpiler.transformSync(text).matchAll(DYNAMIC_LOAD)) {
    calls[m[1] as "import" | "require"]++;
  }
  return {
    import: Math.max(
      0,
      calls.import - imports.filter((i) => i.kind === "dynamic-import").length,
    ),
    require: Math.max(
      0,
      calls.require - imports.filter((i) => i.kind === "require-call").length,
    ),
  };
}

/**
 * The loads of the module at `path` (source `text`) whose path is not a
 * literal — exactly what makes source-digest's `sourceDigest` refuse a closure
 * holding it. For a guard that keeps a closure digestable
 * (`boot:closure-digestable`): the same reading as the digest's.
 */
export function computedLoads(path: string, text: string): ComputedLoads {
  if (!isCodeFile(path)) return { import: 0, require: 0 };
  const transpiler = transpilerFor(path);
  return unseenLoads(transpiler, text, transpiler.scanImports(text));
}
