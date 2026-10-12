import {
  findImports,
  maskSource,
  matchBracket,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// Text-level "go to definition" for no-db-backed-notify: given an identifier a
// body references, find the function / const it names — declared in the same
// file, or imported (relatively or through an `@plugins/…` barrel, following
// re-exports). No type checker: it reads masked source, so it is fast enough to
// run on every check pass and testable on literal strings. What it cannot see
// (a method on an imported object, a default import, a class member, an npm
// package) resolves to nothing — a false negative, never a false positive.

/** Reads repo files by repo-relative path (the check passes `ctx.repo()`). */
export interface ModuleReader {
  has(rel: string): boolean;
  read(rel: string): Promise<string | null>;
}

/** One source file and its masked twin (strings blanked, same offsets). */
export interface ParsedModule {
  rel: string;
  src: string;
  masked: string;
}

/** A resolved declaration: the `[start, end)` text of its whole statement. */
export interface Definition {
  name: string;
  module: ParsedModule;
  start: number;
  end: number;
}

/**
 * How many barrel / re-export hops one import may take before the resolver
 * gives up (a cycle guard as much as a cost bound: barrels are one or two hops
 * deep in this repo).
 */
const MAX_REEXPORT_HOPS = 8;

const TS_EXTENSIONS = [".ts", ".tsx"];

export class ModuleIndex {
  private readonly modules = new Map<string, Promise<ParsedModule | null>>();

  constructor(private readonly reader: ModuleReader) {}

  /** A source already in hand (a candidate file): parsed once, never re-read. */
  seed(rel: string, src: string): ParsedModule {
    const parsed = parse(rel, src);
    this.modules.set(rel, Promise.resolve(parsed));
    return parsed;
  }

  load(rel: string): Promise<ParsedModule | null> {
    let pending = this.modules.get(rel);
    if (!pending) {
      pending = this.reader
        .read(rel)
        .then((src) => (src === null ? null : parse(rel, src)));
      this.modules.set(rel, pending);
    }
    return pending;
  }

  /**
   * The definition `name` refers to inside `module`: a same-file declaration,
   * else the import binding it comes from, resolved in the exporting file.
   */
  async resolve(
    module: ParsedModule,
    name: string,
  ): Promise<Definition | null> {
    return this.resolveIn(module, name, 0);
  }

  private async resolveIn(
    module: ParsedModule,
    name: string,
    hops: number,
  ): Promise<Definition | null> {
    const local = findDeclaration(module, name);
    if (local) return local;
    for (const imp of findImports(module.src)) {
      if (imp.keyword !== "import" || imp.typeOnly || imp.sideEffect) continue;
      const imported = namedBindings(imp.clause).get(name);
      if (imported === undefined) continue;
      return this.resolveExport(module.rel, imp.specifier, imported, hops + 1);
    }
    return null;
  }

  /** `exported` as exported by the module `specifier` names, seen from `fromRel`. */
  private async resolveExport(
    fromRel: string,
    specifier: string,
    exported: string,
    hops: number,
  ): Promise<Definition | null> {
    if (hops > MAX_REEXPORT_HOPS) return null;
    const rel = this.resolveSpecifier(fromRel, specifier);
    if (rel === null) return null;
    const module = await this.load(rel);
    if (!module) return null;

    const local = findDeclaration(module, exported);
    if (local) return local;
    const stars: string[] = [];
    for (const ref of findImports(module.src)) {
      if (ref.keyword !== "export" || ref.typeOnly || ref.sideEffect) continue;
      if (/^\s*\*\s*$/.test(ref.clause)) {
        stars.push(ref.specifier);
        continue;
      }
      const orig = namedBindings(ref.clause).get(exported);
      if (orig !== undefined) {
        return this.resolveExport(rel, ref.specifier, orig, hops + 1);
      }
    }
    // `export { local as exported }` with no `from`: a local alias, or an
    // import re-exported by name.
    const alias = localExportAlias(module.masked, exported);
    if (alias !== null) return this.resolveIn(module, alias, hops + 1);
    // `import { x } from "…"; export { x }`: the import binding of that name.
    const reexported = await this.resolveIn(module, exported, hops + 1);
    if (reexported) return reexported;
    for (const star of stars) {
      const def = await this.resolveExport(rel, star, exported, hops + 1);
      if (def) return def;
    }
    return null;
  }

  /** The repo file a specifier names, or null (npm package, missing file). */
  private resolveSpecifier(fromRel: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith("@plugins/")) {
      base = `plugins/${specifier.slice("@plugins/".length)}`;
    } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
      base = joinRel(dirnameRel(fromRel), specifier);
    } else {
      return null;
    }
    const candidates = TS_EXTENSIONS.some((ext) => base.endsWith(ext))
      ? [base]
      : [
          ...TS_EXTENSIONS.map((ext) => base + ext),
          ...TS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
        ];
    return candidates.find((c) => this.reader.has(c)) ?? null;
  }
}

function parse(rel: string, src: string): ParsedModule {
  return { rel, src, masked: maskSource(src, { strings: true }) };
}

function dirnameRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function joinRel(dir: string, specifier: string): string {
  const out = dir === "" ? [] : dir.split("/");
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * The named bindings of an import / export clause, keyed by the name on the
 * right of `as` (an import's local name, an export's exported name) and mapped
 * to the name on its left. Type-only items are dropped.
 * `{ a, b as c }` → a→a, c→b.
 */
function namedBindings(clause: string): Map<string, string> {
  const out = new Map<string, string>();
  const open = clause.indexOf("{");
  const close = clause.lastIndexOf("}");
  if (open < 0 || close < open) return out;
  for (const raw of clause.slice(open + 1, close).split(",")) {
    const item = raw.trim();
    if (item === "" || /^type\s/.test(item)) continue;
    const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item);
    if (!m) continue;
    out.set(m[2] ?? m[1]!, m[1]!);
  }
  return out;
}

/**
 * `export { local as exported }` with no `from` → `local`; null when no such
 * alias exists (a plain `export { x }` names a binding the caller already
 * looked for under the same name).
 */
function localExportAlias(masked: string, exported: string): string | null {
  const re = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const orig = namedBindings(`{${m[1]!}}`).get(exported);
    if (orig !== undefined && orig !== exported) return orig;
  }
  return null;
}

const escapeId = (name: string) => name.replace(/\$/g, "\\$");

/**
 * The same-file declaration of `name` — `function name(…) {…}` (async and
 * generator forms included) or `const|let|var name = …` — as its whole
 * statement's extent, or null.
 */
export function findDeclaration(
  module: ParsedModule,
  name: string,
): Definition | null {
  const { masked } = module;
  const id = escapeId(name);
  const fn = new RegExp(`(?<![\\w$.])function\\s*\\*?\\s*${id}\\s*[<(]`).exec(
    masked,
  );
  if (fn) {
    const end = functionEnd(masked, fn.index + fn[0].length - 1);
    if (end > 0) return { name, module, start: fn.index, end };
  }
  const decl = new RegExp(
    `(?<![\\w$.])(?:const|let|var)\\s+${id}\\s*[:=]`,
  ).exec(masked);
  if (decl) {
    const end = statementEnd(masked, decl.index + decl[0].length - 1);
    return { name, module, start: decl.index, end };
  }
  return null;
}

/**
 * End (exclusive) of a function declaration whose name is followed by `<` or
 * `(` at `from`: past the parameter list, any return-type annotation, and the
 * body. A `{` block followed by `|`, `&`, `[`, `>` or `,` was part of the
 * return type (`Promise<{ a: T }>`), so the body is the next one.
 */
function functionEnd(masked: string, from: number): number {
  const paramsOpen = masked.indexOf("(", from);
  if (paramsOpen < 0) return -1;
  const paramsClose = matchBracket(masked, paramsOpen, "(", ")");
  if (paramsClose < 0) return -1;
  let i = paramsClose + 1;
  for (;;) {
    const open = masked.indexOf("{", i);
    if (open < 0) return -1;
    const close = matchBracket(masked, open, "{", "}");
    if (close < 0) return -1;
    let next = close + 1;
    while (next < masked.length && /\s/.test(masked[next]!)) next++;
    if (!/[|&[>,]/.test(masked[next] ?? "")) return close + 1;
    i = close + 1;
  }
}

/** A line starting one of these at depth 0 starts a new statement. */
const STATEMENT_START =
  /^(?:export|const|let|var|function|async|class|import|type|interface|enum|declare)\b/;

/**
 * End (exclusive) of a `const name = …` statement from its `=` / `:` at
 * `from`: the first `;` at bracket depth 0, a closing bracket that leaves the
 * enclosing block, or a newline at depth 0 followed by a new statement.
 */
function statementEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from + 1; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth < 0) return i;
    } else if (depth === 0 && c === ";") return i + 1;
    else if (depth === 0 && c === "\n") {
      const rest = masked.slice(i + 1, i + 200).trimStart();
      if (rest === "" || STATEMENT_START.test(rest)) return i;
    }
  }
  return masked.length;
}
