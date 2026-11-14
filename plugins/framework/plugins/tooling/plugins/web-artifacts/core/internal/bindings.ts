// The bindings of an emitted import / re-export statement: which names it
// takes from its target and under which local (or exported) names. The link
// step (`link.ts`) rewrites a statement into one statement per defining module,
// so — unlike `import-clause.ts`, which only needs the imported names — it
// needs both halves of every `a as b`.
//
// Input is bundler output (`import{a as s,b}from"…"`, `export{t as X}from"…"`,
// `import D,{a}from"…"`, `import*as n from"…"`), with or without minification.
// A shape this parser does not recognize is reported as `opaque`: the caller
// leaves the statement untouched (it loads the whole target, as before), never
// rewrites it wrongly.

export interface Binding {
  /** The name the target exports (`default` for a default import). */
  imported: string;
  /** The importer's local name (import) or the exported name (re-export). */
  local: string;
}

export interface StatementBindings {
  /** `export … from`, not `import … from`. */
  reexport: boolean;
  /** Named and default bindings, in source order. */
  named: Binding[];
  /** `import * as ns` / `export * as ns from`: binds the whole namespace. */
  namespace: string | null;
  /** `export * from`: re-exports every name of the target. */
  star: boolean;
  /** No bindings at all: `import "x"` — evaluated for its effects. */
  sideEffectOnly: boolean;
  /** A shape this parser does not read: leave the statement as it is. */
  opaque: boolean;
}

const IDENT = /^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*$/;

function name(raw: string): string | null {
  const t = raw.trim();
  if (IDENT.test(t)) return t;
  const q = t[0];
  if ((q === '"' || q === "'") && t.endsWith(q) && t.length >= 2) {
    const inner = t.slice(1, -1);
    return /["'\\]/.test(inner) ? null : inner;
  }
  return null;
}

/**
 * Parse the statement text up to its specifier: `code.slice(imp.ss, imp.s)`
 * for an es-module-lexer static import record (`imp.d === -1`), i.e. it ends
 * with `from "` (or the opening quote of a side-effect import).
 */
export function parseStatementBindings(text: string): StatementBindings {
  const out: StatementBindings = {
    reexport: false,
    named: [],
    namespace: null,
    star: false,
    sideEffectOnly: false,
    opaque: false,
  };
  let rest = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/['"]$/, "")
    .trim();
  if (/^export\b/.test(rest)) {
    out.reexport = true;
    rest = rest.slice("export".length).trim();
  } else if (/^import\b/.test(rest)) {
    rest = rest.slice("import".length).trim();
  } else {
    return { ...out, opaque: true };
  }
  if (rest === "") {
    if (out.reexport) return { ...out, opaque: true };
    return { ...out, sideEffectOnly: true };
  }
  if (!/\bfrom$/.test(rest)) return { ...out, opaque: true };
  rest = rest.replace(/\bfrom$/, "").trim();

  // `* as ns` / `*`
  const star = /^\*\s*(?:as\s+(.+))?$/.exec(rest);
  if (star !== null) {
    if (star[1] === undefined) {
      if (!out.reexport) return { ...out, opaque: true };
      return { ...out, star: true };
    }
    const ns = name(star[1]);
    return ns === null ? { ...out, opaque: true } : { ...out, namespace: ns };
  }

  const brace = rest.indexOf("{");
  let head = brace >= 0 ? rest.slice(0, brace) : rest;
  head = head.replace(/,\s*$/, "").trim();
  if (head !== "") {
    if (out.reexport) return { ...out, opaque: true };
    // `D` or `D, * as ns`
    const [first, ...tail] = head.split(",");
    const d = name(first!);
    if (d === null) return { ...out, opaque: true };
    out.named.push({ imported: "default", local: d });
    if (tail.length > 0) {
      const ns = /^\*\s*as\s+(.+)$/.exec(tail.join(",").trim());
      const local = ns === null ? null : name(ns[1]!);
      if (local === null) return { ...out, opaque: true };
      out.namespace = local;
    }
  }
  if (brace >= 0) {
    const close = rest.lastIndexOf("}");
    if (close < brace || rest.slice(close + 1).trim() !== "")
      return { ...out, opaque: true };
    for (const entry of rest.slice(brace + 1, close).split(",")) {
      if (entry.trim() === "") continue;
      const parts = entry.trim().split(/\s+as\s+/);
      if (parts.length > 2) return { ...out, opaque: true };
      const imported = name(parts[0]!);
      const local = name(parts[1] ?? parts[0]!);
      if (imported === null || local === null) return { ...out, opaque: true };
      out.named.push({ imported, local });
    }
  }
  return out;
}

/** A binding spelled for a statement (`a`, `a as b`, `"x-y" as b`). */
function spell(raw: string): string {
  return IDENT.test(raw) ? raw : JSON.stringify(raw);
}

/**
 * One statement taking `bindings` from `specifier`: an import, or a re-export
 * when `reexport`. A local name is always an identifier on the import side.
 */
export function renderStatement(opts: {
  reexport: boolean;
  bindings: readonly Binding[];
  specifier: string;
}): string {
  const list = opts.bindings
    .map((b) =>
      b.imported === b.local
        ? spell(b.imported)
        : `${spell(b.imported)} as ${opts.reexport ? spell(b.local) : b.local}`,
    )
    .join(",");
  return `${opts.reexport ? "export" : "import"}{${list}}from${JSON.stringify(opts.specifier)};`;
}
