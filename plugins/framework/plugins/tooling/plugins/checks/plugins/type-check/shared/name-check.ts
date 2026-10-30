// The two-program type check (`./name-run.ts`) — the CHECKER half: what a
// source file imports, what each export's inferred type was computed from,
// and one program's check and emit.
//
// INFERENCE EDGES. A name with no written type has a `.d.ts` the checker
// computed from whatever it referenced: `export const x = foo()` prints
// `foo`'s return type, which an edit of `foo` changes while `x`'s file does not
// change at all. So when a file is checked, each export's declaration is
// walked — minus the bodies and initializers a WRITTEN type makes irrelevant,
// and minus JSX elements (their type is `JSX.Element` whatever they render) —
// and every identifier resolved: an import binding is an edge to the name it
// imports (`m.ts\0foo`); a declaration of this file exported under another
// name, an edge to that name; any other local declaration is walked the same
// way. That is a superset of what the checker can have read for the name's
// type: it reaches another file only through an import binding of this one
// (or a global, which the global hash covers), and what lies BEHIND that
// binding is the target name's own meaning (`./name-walk.ts`).

import { createHash } from "crypto";
import { dirname, join, relative } from "path";
import ts from "typescript";
import {
  canonicalDeclarations,
  formatDiagnostic,
  type DeclaringSpelling,
} from "./tsc-engine";
import {
  createNameHost,
  storedContract,
  type SourceFileCache,
} from "./name-host";
import { contractNames, nameKey, WHOLE, type NameRec } from "./name-records";
import type { RecordingResolver, ResolutionRecord } from "./name-resolve";
import type { RepoView } from "./repo-view";
import { isRepoPath, needsContract } from "./keys";

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

/** Resolve a specifier from a repo file to a repo path (undefined: a dependency or nothing). */
export type RepoResolve = (
  from: string,
  specifier: string,
  mode: number,
) => string | undefined;

const modeOf = (
  sf: ts.SourceFile,
  lit: ts.StringLiteralLike,
  options: ts.CompilerOptions,
): number => ts.getModeForUsageLocation(sf, lit, options) ?? -1;

/** One import of a source file: [specifier, mode, imported name] — `*` the whole module, `` none (a side-effect import, an augmentation). */
export type FileImport = [string, number, string];

/**
 * Every module a source file's own text names, and which of its names: import
 * and export declarations, `import x = require()`, import types, dynamic
 * imports, module augmentations. PURE syntax (plus the mode, from the options).
 */
export function fileImports(
  sf: ts.SourceFile,
  options: ts.CompilerOptions,
): FileImport[] {
  const out = new Map<string, FileImport>();
  const note = (lit: ts.Node | undefined, name: string): void => {
    if (lit === undefined || !ts.isStringLiteralLike(lit)) return;
    const mode = modeOf(sf, lit, options);
    out.set(`${lit.text}\0${mode}\0${name}`, [lit.text, mode, name]);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      if (c === undefined) note(n.moduleSpecifier, "");
      else {
        if (c.name) note(n.moduleSpecifier, "default");
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) note(n.moduleSpecifier, WHOLE);
        else if (nb) {
          for (const e of nb.elements) {
            note(n.moduleSpecifier, (e.propertyName ?? e.name).text);
          }
        }
        if (!c.name && !nb) note(n.moduleSpecifier, "");
      }
      return;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) {
      const c = n.exportClause;
      if (c === undefined || ts.isNamespaceExport(c)) {
        note(n.moduleSpecifier, WHOLE);
      } else {
        for (const e of c.elements) {
          note(n.moduleSpecifier, (e.propertyName ?? e.name).text);
        }
        if (c.elements.length === 0) note(n.moduleSpecifier, "");
      }
      return;
    }
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference)
    ) {
      note(n.moduleReference.expression, WHOLE);
      return;
    }
    if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) {
      note(n.name, "");
    } else if (ts.isImportTypeNode(n)) {
      if (ts.isLiteralTypeNode(n.argument)) {
        let name: string = WHOLE;
        if (n.qualifier !== undefined) {
          let e: ts.EntityName = n.qualifier;
          while (!ts.isIdentifier(e)) e = e.left;
          name = e.text;
        }
        note(n.argument.literal, name);
      }
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
      n.arguments.length > 0
    ) {
      note(n.arguments[0], WHOLE);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out.values()].sort((a, b) =>
    a.join("\0") < b.join("\0") ? -1 : 1,
  );
}

/**
 * A file's uses as name keys: its named imports, through its resolution
 * targets, and the ambient `.d.ts` its specifiers match (`ambientUses`).
 */
export function usesOf(
  imports: readonly FileImport[],
  targets: readonly [string, number, string][],
  ambient: AmbientModules,
): string[] {
  const at = new Map(targets.map(([s, m, t]) => [`${s}\0${m}`, t]));
  const out = new Set<string>();
  for (const [spec, mode, name] of imports) {
    if (name === "") continue;
    const t = at.get(`${spec}\0${mode}`);
    if (t === undefined) {
      throw new Error(
        `name-check: no resolution recorded for "${spec}" (mode ${mode})`,
      );
    }
    if (t === "-" || t === "<dep>") continue;
    out.add(nameKey(t, name));
  }
  for (const k of ambientUses(imports, ambient)) out.add(k);
  return [...out].sort();
}

/** The internals of a source file the TS builder reads too. */
interface SourceFileInternals {
  moduleAugmentations: readonly (ts.StringLiteral | ts.Identifier)[];
}

/**
 * Whether a file is GLOBAL: tsc's own `isFileAffectingGlobalScope` (a
 * `declare global`, or a script — not a module, not JSON, not only ambient
 * module declarations), or a module augmentation: every importer of the
 * augmented module sees it without naming this file. Its version is in the
 * global hash.
 */
export function isGlobalFile(sf: ts.SourceFile): boolean {
  const raw = sf as unknown as Partial<SourceFileInternals>;
  if (!Array.isArray(raw.moduleAugmentations)) {
    throw new Error(
      `type-check: ${sf.fileName} has no moduleAugmentations — this TypeScript (${ts.version}) moved the internal`,
    );
  }
  if (raw.moduleAugmentations.length > 0) return true;
  if (ts.isExternalModule(sf) || sf.fileName.endsWith(".json")) return false;
  return !sf.statements.every(
    (s) =>
      ts.isModuleDeclaration(s) &&
      (ts.isStringLiteral(s.name) ||
        (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
  );
}

/**
 * Whether the checker sees a declaration file as global: `isGlobalFile`, or
 * a reference directive (it loads more declarations into the program).
 */
function isGlobalDecl(sf: ts.SourceFile): boolean {
  return (
    sf.referencedFiles.length > 0 ||
    sf.typeReferenceDirectives.length > 0 ||
    sf.libReferenceDirectives.length > 0 ||
    isGlobalFile(sf)
  );
}

/** The binding an import alias declaration stands for, as a name key. */
function importKey(
  d: ts.Declaration,
  sf: ts.SourceFile,
  path: string,
  options: ts.CompilerOptions,
  resolve: RepoResolve,
): string | null | undefined {
  // undefined: not an import binding; null: an import of a dependency.
  let spec: ts.Expression | undefined;
  let name: string;
  if (ts.isImportSpecifier(d)) {
    spec = d.parent.parent.parent.moduleSpecifier;
    name = (d.propertyName ?? d.name).text;
  } else if (ts.isImportClause(d)) {
    spec = d.parent.moduleSpecifier;
    name = "default";
  } else if (ts.isNamespaceImport(d)) {
    spec = d.parent.parent.moduleSpecifier;
    name = WHOLE;
  } else if (
    ts.isImportEqualsDeclaration(d) &&
    ts.isExternalModuleReference(d.moduleReference)
  ) {
    spec = d.moduleReference.expression;
    name = WHOLE;
  } else return undefined;
  if (!ts.isStringLiteralLike(spec)) return null;
  const m = resolve(path, spec.text, modeOf(sf, spec, options));
  return m === undefined ? null : nameKey(m, name);
}

/** Whether a subtree assigns a variable, outside the functions nested in it. */
function assigns(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (
      (ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** The node whose subtree decides a declaration's type. */
function typeRoot(d: ts.Node): ts.Node {
  let n = d;
  while (
    ts.isBindingElement(n) ||
    ts.isObjectBindingPattern(n) ||
    ts.isArrayBindingPattern(n)
  ) {
    n = n.parent;
  }
  return n;
}

/**
 * Each export's inference edges (see the header): export name → sorted name
 * keys. A re-export has none (its record is an alias edge).
 */
export function inferenceEdges(
  sf: ts.SourceFile,
  path: string,
  checker: ts.TypeChecker,
  options: ts.CompilerOptions,
  resolve: RepoResolve,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (moduleSymbol === undefined) return out;
  // Each export's own declarations in this file; each declaration's export name.
  const declsOf = new Map<string, ts.Node[]>();
  const exportOfDecl = new Map<ts.Node, string>();
  for (const e of checker.getExportsOfModule(moduleSymbol)) {
    let s: ts.Symbol | undefined = e;
    const roots: ts.Node[] = [];
    // Follow local aliases (`export { a as b }`, `export default a`) to the
    // declaration; stop at an import or a re-export.
    for (let hops = 0; s !== undefined && hops < 16; hops++) {
      if (!(s.flags & ts.SymbolFlags.Alias)) break;
      const d = s.declarations?.[0];
      if (d === undefined || d.getSourceFile() !== sf) {
        s = undefined;
        break;
      }
      if (ts.isExportAssignment(d)) {
        if (ts.isIdentifier(d.expression)) {
          s = checker.getSymbolAtLocation(d.expression);
          continue;
        }
        roots.push(d.expression);
        s = undefined;
        break;
      }
      if (
        ts.isExportSpecifier(d) &&
        d.parent.parent.moduleSpecifier === undefined
      ) {
        s = checker.getImmediateAliasedSymbol(s);
        continue;
      }
      s = undefined; // an import, or `export … from`
      break;
    }
    for (const d of s?.declarations ?? []) {
      if (d.getSourceFile() !== sf) continue;
      const r = typeRoot(d);
      roots.push(r);
      if (!exportOfDecl.has(r)) exportOfDecl.set(r, e.name);
    }
    if (roots.length > 0) declsOf.set(e.name, roots);
  }

  for (const [name, roots] of declsOf) {
    const deps = new Set<string>();
    const visited = new Set<ts.Node>(roots);
    const onSymbol = (sym: ts.Symbol | undefined, depth = 0): void => {
      if (sym === undefined || depth > 16) return;
      if (sym.flags & ts.SymbolFlags.Alias) {
        const d = sym.declarations?.[0];
        if (d === undefined || d.getSourceFile() !== sf) return;
        const k = importKey(d, sf, path, options, resolve);
        if (k !== undefined) {
          if (k !== null) deps.add(k);
          return;
        }
        onSymbol(checker.getImmediateAliasedSymbol(sym), depth + 1);
        return;
      }
      for (const d of sym.declarations ?? []) {
        if (d.getSourceFile() !== sf) continue;
        const r = typeRoot(d);
        const as = exportOfDecl.get(r);
        if (as !== undefined && as !== name) {
          deps.add(nameKey(path, as));
          continue;
        }
        if (visited.has(r)) continue;
        visited.add(r);
        visit(r);
      }
    };
    const visit = (n: ts.Node): void => {
      // A written type makes the body / initializer irrelevant to the type.
      if (
        (ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isGetAccessorDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n)) &&
        n.type !== undefined &&
        n.body !== undefined
      ) {
        const body = n.body;
        ts.forEachChild(n, (c) => {
          if (c !== body) visit(c);
        });
        return;
      }
      if (
        (ts.isVariableDeclaration(n) ||
          ts.isPropertyDeclaration(n) ||
          ts.isParameter(n)) &&
        n.type !== undefined &&
        n.initializer !== undefined
      ) {
        visit(n.name);
        visit(n.type);
        return;
      }
      // A JSX element's type is the global `JSX.Element`, whatever its tag,
      // props or children (`checkJsxElement`): nothing inside it feeds an
      // inferred type — unless it assigns, which moves the flow type of a
      // variable read after it.
      if (
        (ts.isJsxElement(n) ||
          ts.isJsxSelfClosingElement(n) ||
          ts.isJsxFragment(n)) &&
        !assigns(n)
      ) {
        return;
      }
      if (ts.isIdentifier(n)) {
        onSymbol(checker.getSymbolAtLocation(n));
        return;
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        onSymbol(checker.getShorthandAssignmentValueSymbol(n));
      } else if (ts.isImportTypeNode(n)) {
        if (
          ts.isLiteralTypeNode(n.argument) &&
          ts.isStringLiteralLike(n.argument.literal)
        ) {
          let q: string = WHOLE;
          if (n.qualifier !== undefined) {
            let e: ts.EntityName = n.qualifier;
            while (!ts.isIdentifier(e)) e = e.left;
            q = e.text;
          }
          const lit = n.argument.literal;
          const m = resolve(path, lit.text, modeOf(sf, lit, options));
          if (m !== undefined) deps.add(nameKey(m, q));
        }
        n.typeArguments?.forEach(visit);
        return;
      } else if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments.length > 0 &&
        ts.isStringLiteralLike(n.arguments[0]!)
      ) {
        const lit = n.arguments[0];
        const m = resolve(path, lit.text, modeOf(sf, lit, options));
        if (m !== undefined) deps.add(nameKey(m, WHOLE));
      }
      ts.forEachChild(n, visit);
    };
    for (const r of roots) visit(r);
    deps.delete(nameKey(path, name));
    out.set(name, [...deps].sort());
  }
  return out;
}

/**
 * Whether a file's SYNTAX makes it global: a `declare global`, or a module
 * augmentation (`declare module "x"`). Every file is a module here
 * (`moduleDetection: force`), so this is `isGlobalFile` without a program —
 * decided before program 1 is built, and checked against it after.
 */
export function declaresGlobals(text: string, fileName: string): boolean {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const visit = (statements: readonly ts.Statement[]): boolean =>
    statements.some(
      (s) =>
        ts.isModuleDeclaration(s) &&
        (ts.isStringLiteral(s.name) ||
          (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
    );
  return visit(sf.statements);
}

/**
 * What a repo `.d.ts` root of the program (every program holds them all) can
 * reach, from its SYNTAX:
 *
 *   - `global`: every file sees it without naming it — a script (no import or
 *     export) declaring anything but string-named modules, a `declare global`,
 *     an augmentation (`declare module "x"` in a module), or a `/// <reference>`
 *     (it loads more declarations into every program). Its version is in the
 *     global hash.
 *   - `ambient`: only string-named module declarations, in a script — each an
 *     AMBIENT MODULE (`declare module "@browser-host/*"`), seen only by a file
 *     whose specifier it matches. Such a file uses it (`ambientUses`).
 *   - `module`: an ordinary module, seen through an import of its path (a
 *     `decl` owner in the walk).
 *
 * Checked against the checker's own `isGlobalFile` in every program
 * (`runProgram`), as `declaresGlobals` is for source files.
 */
export type DeclScope =
  | { kind: "global" }
  | { kind: "ambient"; patterns: string[] }
  | { kind: "module" };

export function declScope(text: string, fileName: string): DeclScope {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  if (
    sf.referencedFiles.length > 0 ||
    sf.typeReferenceDirectives.length > 0 ||
    sf.libReferenceDirectives.length > 0
  ) {
    return { kind: "global" };
  }
  const named = (
    s: ts.Statement,
  ): s is ts.ModuleDeclaration & {
    name: ts.StringLiteral;
  } => ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name);
  const declaresGlobal = sf.statements.some(
    (s) =>
      ts.isModuleDeclaration(s) &&
      (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0,
  );
  if (declaresGlobal) return { kind: "global" };
  if (ts.isExternalModule(sf)) {
    return sf.statements.some(named)
      ? { kind: "global" } // an augmentation
      : { kind: "module" };
  }
  if (sf.statements.length === 0 || !sf.statements.every(named)) {
    return { kind: "global" };
  }
  return {
    kind: "ambient",
    patterns: [
      ...new Set(sf.statements.filter(named).map((s) => s.name.text)),
    ].sort(),
  };
}

/** Whether a specifier matches an ambient module name (one `*` at most, as TypeScript's). */
function ambientMatches(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  return (
    specifier.length >= pre.length + post.length &&
    specifier.startsWith(pre) &&
    specifier.endsWith(post)
  );
}

/** The ambient-module `.d.ts` roots of a run: path → the module names it declares. */
export type AmbientModules = ReadonlyMap<string, readonly string[]>;

/**
 * The ambient `.d.ts` a file's imports can reach: every one declaring a module
 * name one of its specifiers matches, whatever the specifier resolved to (an
 * exact ambient name wins over resolution, a pattern applies where it fails
 * — matching either way over-approximates, never misses). Each is a use of
 * the whole `.d.ts`, so its version keys exactly these files.
 */
export function ambientUses(
  imports: readonly FileImport[],
  ambient: AmbientModules,
): string[] {
  if (ambient.size === 0) return [];
  const out = new Set<string>();
  for (const [spec] of imports) {
    for (const [decl, patterns] of ambient) {
      if (patterns.some((pat) => ambientMatches(pat, spec))) {
        out.add(nameKey(decl, WHOLE));
      }
    }
  }
  return [...out];
}

/** One source file's check: its diagnostics, signature, and raw `.d.ts`. */
export interface FileCheck {
  /** Syntactic, semantic and declaration diagnostics, formatted. */
  diagnostics: string[];
  /** The hash of its canonical `.d.ts` and declaration diagnostics. */
  signature: string;
  /** Its canonical `.d.ts`: what per-name records are read from. */
  canonical: string;
  /** Its raw `.d.ts`: what importers are served. */
  raw: string;
  /**
   * Its declaration emit reported a diagnostic: the `.d.ts` does not say what
   * the source does (a type it cannot name prints as a name it does not
   * import), so it must never stand for the source (`storedContract`).
   */
  unservable: boolean;
}

/**
 * For `canonicalDeclarations`: how to spell the type `import(spec).<path>`
 * names, as `sf` sees it — following re-exports through the checker, so two
 * programs that printed one type by two routes spell it one way. Undefined
 * (keep the spelling) when it does not resolve.
 *
 * - Declared in the repo: by the spec, relative to `sf`, of the repo file that
 *   DECLARES `path[0]` as the module `spec` exports it — so a barrel and the
 *   file behind it spell one type one way whichever this program resolved it
 *   by. A served contract (`x.d.ts` beside `x.ts`) and its source spell the
 *   same, extension dropped. Declarations merged across files are named by the
 *   first by path.
 * - Declared outside the repo, spelled through a namespace: through `spec`
 *   still, by the SHORTEST export path that reaches the symbol (ties by
 *   text) — so zod's `$brand`, printed `z.core.$brand` through the
 *   namespaces in one program and `$brand` in another, is `$brand` in both.
 */
function declaringSpecOf(
  root: string,
  program: ts.Program,
  sf: ts.SourceFile,
): (spec: string, path: readonly string[]) => DeclaringSpelling | undefined {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  // Repo candidates are the PROGRAM's files: a module served as its contract
  // (`x.d.ts`) resolves to that, not to the `x.ts` on disk beside it. A
  // dependency is found as tsc found it, on disk through its symlinks.
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) =>
      program.getSourceFile(f) !== undefined ||
      ((f.endsWith("/package.json") || !isRepoPath(rel(root, f))) &&
        ts.sys.fileExists(f)),
    readFile: (f) => ts.sys.readFile(f),
    realpath: (f) => (isRepoPath(rel(root, f)) ? f : ts.sys.realpath!(f)),
  };
  const resolveAlias = (s: ts.Symbol): ts.Symbol =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const moduleOf = new Map<string, ts.Symbol | undefined>();
  const moduleSymbol = (spec: string): ts.Symbol | undefined => {
    if (moduleOf.has(spec)) return moduleOf.get(spec);
    const resolved = ts.resolveModuleName(spec, sf.fileName, options, host)
      .resolvedModule?.resolvedFileName;
    const target =
      resolved === undefined ? undefined : program.getSourceFile(resolved);
    const mod =
      target === undefined ? undefined : checker.getSymbolAtLocation(target);
    moduleOf.set(spec, mod);
    return mod;
  };
  /** A module's or namespace's member `name`, aliases followed. */
  const member = (of: ts.Symbol, name: string): ts.Symbol | undefined => {
    const m = checker.getExportsOfModule(of).find((e) => e.name === name);
    return m === undefined ? undefined : resolveAlias(m);
  };
  /** Every symbol reachable from `mod` through its exports, by its shortest path. */
  const shortest = new Map<ts.Symbol, Map<ts.Symbol, string[]>>();
  const pathsFrom = (mod: ts.Symbol): Map<ts.Symbol, string[]> => {
    let out = shortest.get(mod);
    if (out !== undefined) return out;
    out = new Map();
    // Breadth first, each level's names in text order: the first path to
    // reach a symbol is a shortest one, and the least by text among them.
    let level: [ts.Symbol, string[]][] = [[mod, []]];
    const seen = new Set<ts.Symbol>([mod]);
    while (level.length > 0) {
      const next: [ts.Symbol, string[]][] = [];
      for (const [of, at] of level) {
        const names = checker
          .getExportsOfModule(of)
          .map((e) => e.name)
          .sort();
        for (const name of names) {
          const s = member(of, name);
          if (s === undefined || seen.has(s)) continue;
          seen.add(s);
          const p = [...at, name];
          out.set(s, p);
          if (
            s.flags &
            (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)
          ) {
            next.push([s, p]);
          }
        }
      }
      next.sort(([, x], [, y]) =>
        x.join(".") < y.join(".") ? -1 : x.join(".") > y.join(".") ? 1 : 0,
      );
      level = next;
    }
    shortest.set(mod, out);
    return out;
  };
  const memo = new Map<string, DeclaringSpelling | undefined>();
  return (spec, path) => {
    const key = `${spec}\0${path.join(".")}`;
    if (memo.has(key)) return memo.get(key);
    let out: DeclaringSpelling | undefined;
    const mod = moduleSymbol(spec);
    let sym = mod;
    for (const name of path) {
      if (sym === undefined) break;
      sym = member(sym, name);
    }
    const head = mod === undefined ? undefined : member(mod, path[0]!);
    const repoFiles = (s: ts.Symbol | undefined): string[] =>
      (s?.declarations ?? [])
        .map((d) => rel(root, d.getSourceFile().fileName))
        .filter(isRepoPath)
        .sort();
    const files = repoFiles(head);
    if (files.length > 0) {
      const bare = files[0]!.replace(/(\.d)?\.[mc]?tsx?$/, "");
      const from = dirname(rel(root, sf.fileName));
      const r = relative(from, bare).split("\\").join("/");
      out = { spec: r.startsWith(".") ? r : `./${r}`, path };
    } else if (
      // One name is as short as a path gets: no walk.
      path.length > 1 &&
      mod !== undefined &&
      sym !== undefined &&
      (sym.declarations ?? []).length > 0 &&
      repoFiles(sym).length === 0
    ) {
      const p = pathsFrom(mod).get(sym);
      if (p !== undefined) out = { spec, path: p };
    }
    memo.set(key, out);
    return out;
  };
}

/**
 * Check one source file: its syntactic, semantic and declaration diagnostics,
 * and its `.d.ts` — forced even when a declaration diagnostic would block it
 * — whose canonical form (sorted type-literal properties and union members,
 * types through an import binding spelled as import types;
 * `canonicalDeclarations`), with those diagnostics, is the signature. The RAW
 * text is what importers are served: served canonical, it changes how tsc
 * PRINTS a type in an importer's diagnostics (`{ entityId; …; title }` for
 * `{ source; entityId; … }`), measured as order-only divergences.
 */
export function checkFile(
  root: string,
  program: ts.Program,
  sf: ts.SourceFile,
): FileCheck {
  const syntactic = program.getSyntacticDiagnostics(sf);
  const semantic = program.getSemanticDiagnostics(sf);
  const declaration = program.getDeclarationDiagnostics(sf);
  let dts: string | undefined;
  // `forceDtsEmit`, the sixth parameter (a TypeScript internal, the builder
  // passes it to compute a signature): a file whose declaration emit reports a
  // diagnostic still emits its `.d.ts`.
  (
    program.emit.bind(program) as (
      targetSourceFile: ts.SourceFile,
      writeFile: ts.WriteFileCallback,
      cancellationToken: undefined,
      emitOnlyDtsFiles: true,
      customTransformers: undefined,
      forceDtsEmit: true,
    ) => ts.EmitResult
  )(
    sf,
    (fileName, text) => {
      if (/\.d\.[mc]?ts$/.test(fileName)) dts = text;
    },
    undefined,
    true,
    undefined,
    true,
  );
  if (dts === undefined) {
    throw new Error(
      `type-check: emitting ${rel(root, sf.fileName)}'s declaration produced no .d.ts`,
    );
  }
  const declLines = declaration.map((d) => formatDiagnostic(root, d));
  const canonical = canonicalDeclarations(
    dts,
    declaringSpecOf(root, program, sf),
  );
  return {
    diagnostics: [
      ...syntactic.map((d) => formatDiagnostic(root, d)),
      ...semantic.map((d) => formatDiagnostic(root, d)),
      ...declLines,
    ],
    signature: sha256(`${canonical}\n${declLines.join("\n")}`),
    canonical,
    raw: dts,
    unservable: declaration.length > 0,
  };
}

// ─── One program ────────────────────────────────────────────────────────────

/** A source file as checked this run: everything its stored entry records. */
export interface CheckedFile {
  global: boolean;
  imports: FileImport[];
  res: ResolutionRecord;
  uses: string[];
  names: Record<string, NameRec>;
  star: string[];
  diagnostics: string[];
  signature: string;
  /** Its raw `.d.ts`, as stored and served (`storedContract`: marked when unservable). */
  contract: string;
}

export interface ProgramStats {
  /** Repo source files in the program. */
  sources: number;
  /** Of which, checked (the rest are there to be linted). */
  checked: number;
  /** Repo source files served as their stored `.d.ts`. */
  contracts: number;
  /** Repo source files held as source because their `.d.ts` is unservable. */
  held: number;
  /** Repo declaration inputs (`.d.ts`, JSON). */
  repoDecls: number;
  /** lib, `@types`, `node_modules`. */
  env: number;
  /** Building the program (resolution, parse, bind), wall ms. */
  programMs: number;
  /** Diagnostics and `.d.ts` emit, wall ms. */
  checkMs: number;
  /** Per-name records, imports, resolutions and inference edges, wall ms. */
  recordMs: number;
}

export interface ProgramRun {
  program: ts.Program;
  checked: Map<string, CheckedFile>;
  /** Each repo file served as a `.d.ts` → the hash of the text served. */
  served: Map<string, string>;
  /** Options and global diagnostics, formatted. */
  programDiagnostics: string[];
  stats: ProgramStats;
}

/**
 * A name of an UNSERVABLE file (`FileCheck.unservable`): its users read the
 * file's SOURCE, so the name means what the source does — its text (the
 * file's, not only the `.d.ts`'s, which cannot say it) and everything the
 * source uses, as d-edges. An edit of the file, or of anything it reads, moves
 * the name and re-checks its users.
 */
function unservableName(
  r: Pick<NameRec, "t" | "d">,
  text: string,
  uses: readonly string[],
): Pick<NameRec, "t" | "d"> {
  return {
    t: sha256(`unservable\0${r.t}\0${sha256(text)}`).slice(0, 32),
    d: [...new Set([...r.d, ...uses])].sort(),
  };
}

export function runProgram(input: {
  /** The repo as the check sees it (`./repo-view.ts`); its root is the program's. */
  view: RepoView;
  options: ts.CompilerOptions;
  /** The repo source files the program holds as source. */
  sources: ReadonlySet<string>;
  /** The ones to check (the rest of `sources` are only linted). */
  check: ReadonlySet<string>;
  /** Repo `.d.ts` roots (the tsconfig's), in every program as in a whole one. */
  declRoots: readonly string[];
  /** Global source files: their `.d.ts` is in every program they are not sources of. */
  globals: readonly string[];
  /** The repo `.d.ts` roots' scopes (`declScope`), checked against the checker's. */
  declScopes: ReadonlyMap<string, DeclScope>;
  /** The ambient-module `.d.ts` roots, for each checked file's uses. */
  ambient: AmbientModules;
  contractOf(path: string): string;
  cache: SourceFileCache;
  resolver: RecordingResolver;
}): ProgramRun {
  const { view, options, sources, check, resolver } = input;
  const root = view.root;
  const host = createNameHost({
    view,
    options,
    sources,
    contractOf: input.contractOf,
    cache: input.cache,
  });
  const t0 = performance.now();
  const rootNames = [
    ...[...sources].map((p) => join(root, p)),
    ...input.declRoots.map((p) => join(root, p)),
  ];
  for (const g of input.globals) {
    if (!sources.has(g)) rootNames.push(host.contractRoot(g));
  }
  const program = ts.createProgram({ rootNames, options, host: host.host });
  const checker = program.getTypeChecker();
  const programMs = performance.now() - t0;

  const stats: ProgramStats = {
    sources: 0,
    checked: 0,
    contracts: 0,
    held: 0,
    repoDecls: 0,
    env: 0,
    programMs,
    checkMs: 0,
    recordMs: 0,
  };
  const byPath = new Map<string, ts.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    const p = host.repoPathOf(sf.fileName);
    if (!isRepoPath(p)) {
      stats.env++;
      continue;
    }
    if (p !== rel(root, sf.fileName)) {
      stats.contracts++;
      continue;
    }
    if (needsContract(p)) {
      if (host.held.has(p)) {
        stats.held++;
        continue;
      }
      if (!sources.has(p)) {
        throw new Error(
          `type-check: ${p} entered the program as source, but is not one of its sources`,
        );
      }
      stats.sources++;
      byPath.set(p, sf);
    } else {
      stats.repoDecls++;
      const scope = input.declScopes.get(p);
      if (
        scope !== undefined &&
        (scope.kind === "global") !== isGlobalDecl(sf)
      ) {
        throw new Error(
          `type-check: ${p} is ${scope.kind === "global" ? "" : "not "}global by its syntax (declScope), and the checker says otherwise — declScope is missing a case`,
        );
      }
    }
  }

  const checked = new Map<string, CheckedFile>();
  for (const p of check) {
    const sf = byPath.get(p);
    if (sf === undefined) {
      throw new Error(
        `type-check: ${p} is not in the program it is checked in`,
      );
    }
    const t1 = performance.now();
    const fc = checkFile(root, program, sf);
    const t2 = performance.now();
    const imports = fileImports(sf, options);
    const resolve: RepoResolve = (from, spec, mode) => {
      const t = resolver.target(from, spec, mode);
      return t === "-" || t === "<dep>" ? undefined : t;
    };
    const cn = contractNames(fc.canonical, p, (spec) => resolve(p, spec, -1));
    const inferred = inferenceEdges(sf, p, checker, options, resolve);
    const specs = new Map<string, [string, number]>();
    for (const [s, m] of imports) specs.set(`${s}\0${m}`, [s, m]);
    for (const s of cn.specifiers) specs.set(`${s}\0-1`, [s, -1]);
    const res = resolver.record(p, [...specs.values()]);
    const uses = usesOf(imports, res.targets, input.ambient);
    const names: Record<string, NameRec> = {};
    for (const [n, r] of Object.entries(cn.names)) {
      const rec = fc.unservable ? unservableName(r, sf.text, uses) : r;
      names[n] = { ...rec, i: inferred.get(n) ?? [] };
    }
    checked.set(p, {
      global: isGlobalFile(sf),
      imports,
      res,
      uses,
      names,
      star: cn.star,
      diagnostics: fc.diagnostics,
      signature: fc.signature,
      contract: storedContract(fc.raw, fc.unservable),
    });
    stats.checkMs += t2 - t1;
    stats.recordMs += performance.now() - t2;
    stats.checked++;
  }
  const programDiagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ].map((d) => formatDiagnostic(root, d));
  return { program, checked, served: host.served, programDiagnostics, stats };
}
