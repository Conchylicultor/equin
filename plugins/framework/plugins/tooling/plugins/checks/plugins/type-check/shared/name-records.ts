// The two-program type check (`./name-run.ts`) — what one file's contract says
// per exported NAME. PURE: `.d.ts` text in, records out. The checker half
// (what each name's inferred type was computed from, what a source file
// reads) is `./name-check.ts`; how records become keys is `./name-walk.ts`.
//
// A NAME KEY is `path\0name`: an export `name` of the repo file `path`.
// `WHOLE` (`*`) stands for "some name of the module" — a namespace import, an
// `export *` target's set, `typeof import("x")`.
//
// Per exported name, a file's record holds:
//   - `t`: the hash of the name's canonical `.d.ts` text — its own statements
//     plus every NON-exported local statement they reference, transitively
//     (tsc emits a local helper type or `declare const _default` beside the
//     export that names it). An alias (`export { X } from "./x"`, or an import
//     re-exported) hashes its target instead;
//   - `d`: the NAME-USE edges — the names its `.d.ts` text references outside
//     itself: an import binding (`import { R } from "../registry"` →
//     `registry.ts\0R`), an import type (`import("./e").T` → `e.ts\0T`), or
//     another export of the same file. First hop only: a name reached through
//     a barrel is an edge to the barrel's name, whose own record is an alias
//     edge to the next hop — so a re-export that moves is a change of the
//     barrel's name, and the chain is the closure's to follow;
//   - `i`: the INFERENCE edges (`./name-check.ts`): what its inferred type
//     was computed from, which the `.d.ts` text need not mention.
//
// `export * from "m"` is a STAR edge of the file, not a record: which names it
// brings is `m`'s set, so a change of `m\0n` is a change of `file\0n`.
//
// MEANING, NOT TEXT (`./name-walk.ts`): a name's meaning hash covers its text
// and the meanings of its name-use edges' targets. So `f(r: PluginRegistry)`,
// whose text does not move when `PluginRegistry` does, moves through its
// name-use edge, and so does the key of every file that uses `f`.

import { createHash } from "crypto";
import ts from "typescript";

/** "Some name of the module": a namespace use, a star set, `typeof import()`. */
export const WHOLE = "*";

export const nameKey = (path: string, name: string): string =>
  `${path}\0${name}`;

export function splitKey(key: string): [path: string, name: string] {
  const i = key.indexOf("\0");
  return [key.slice(0, i), key.slice(i + 1)];
}

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

/** One exported name's record. */
export interface NameRec {
  /** Hash of its canonical `.d.ts` text (or of its alias target). */
  t: string;
  /** Name-use edges, from its `.d.ts` text: sorted name keys. */
  d: string[];
  /** Inference edges, from the checker: sorted name keys. */
  i: string[];
}

/** What a contract says per name. */
export interface ContractNames {
  names: Record<string, NameRec>;
  /** `export * from` targets in the repo, sorted. */
  star: string[];
  /** Every module specifier the `.d.ts` names, sorted (its resolutions are part of the file's key). */
  specifiers: string[];
}

/**
 * Where a `.d.ts` specifier lands, from the source's location: a repo path,
 * or undefined for a dependency or an ambient module (the engine and the
 * global hash cover those).
 */
export type ResolveSpec = (specifier: string) => string | undefined;

type Binding =
  | { kind: "import"; key: string | undefined; spec: string }
  | { kind: "decl"; stmts: number[] };

type Export =
  | { kind: "local"; local: string }
  | { kind: "alias"; key: string | undefined; spec: string };

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/**
 * Per-name records of one canonical `.d.ts` (`canonicalDeclarations`), its
 * name-use edges resolved from the source's location. Inference edges (`i`)
 * are left empty — the checker half fills them.
 */
export function contractNames(
  dts: string,
  self: string,
  resolve: ResolveSpec,
): ContractNames {
  const sf = ts.createSourceFile(
    "contract.d.ts",
    dts,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const bindings = new Map<string, Binding>();
  const exports = new Map<string, Export>();
  const star = new Set<string>();
  const specifiers = new Set<string>();
  const keyOf = (spec: string, name: string): string | undefined => {
    specifiers.add(spec);
    const m = resolve(spec);
    return m === undefined ? undefined : nameKey(m, name);
  };
  const bindDecl = (name: string, stmt: number): void => {
    const b = bindings.get(name);
    if (b !== undefined && b.kind === "decl") b.stmts.push(stmt);
    else bindings.set(name, { kind: "decl", stmts: [stmt] });
  };

  // Per statement: its text, the identifiers it mentions, the import types.
  const stmtText: string[] = [];
  const stmtRefs: Set<string>[] = [];
  const stmtImportTypes: Set<string>[] = [];

  sf.statements.forEach((st, idx) => {
    stmtText.push(dts.slice(st.getStart(sf), st.end));
    const refs = new Set<string>();
    const types = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) refs.add(n.text);
      else if (ts.isImportTypeNode(n)) {
        if (
          ts.isLiteralTypeNode(n.argument) &&
          ts.isStringLiteral(n.argument.literal)
        ) {
          const spec = n.argument.literal.text;
          const q = n.qualifier;
          // `import("x").A.B` names `A` of `x`; `typeof import("x").a` the
          // value `a`; a bare `import("x")` the whole module.
          let left: string = WHOLE;
          if (q !== undefined) {
            let e: ts.EntityName = q;
            while (!ts.isIdentifier(e)) e = e.left;
            left = e.text;
          }
          const k = keyOf(spec, left);
          if (k !== undefined) types.add(k);
        }
        // The qualifier's identifiers name the target module's members, not
        // locals here.
        if (n.typeArguments) n.typeArguments.forEach(visit);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(st);
    stmtRefs.push(refs);
    stmtImportTypes.push(types);

    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const clause = st.importClause;
      if (clause === undefined) return;
      if (clause.name) {
        bindings.set(clause.name.text, {
          kind: "import",
          key: keyOf(spec, "default"),
          spec,
        });
      }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        bindings.set(nb.name.text, {
          kind: "import",
          key: keyOf(spec, WHOLE),
          spec,
        });
      } else if (nb) {
        for (const e of nb.elements) {
          bindings.set(e.name.text, {
            kind: "import",
            key: keyOf(spec, (e.propertyName ?? e.name).text),
            spec,
          });
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(st)) {
      if (ts.isExternalModuleReference(st.moduleReference)) {
        const spec = (st.moduleReference.expression as ts.StringLiteral).text;
        bindings.set(st.name.text, {
          kind: "import",
          key: keyOf(spec, WHOLE),
          spec,
        });
      } else bindDecl(st.name.text, idx);
      if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        exports.set(st.name.text, { kind: "local", local: st.name.text });
      }
      return;
    }
    if (ts.isExportDeclaration(st)) {
      const clause = st.exportClause;
      if (st.moduleSpecifier !== undefined) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        if (clause === undefined) {
          specifiers.add(spec);
          const m = resolve(spec);
          if (m !== undefined) star.add(m);
        } else if (ts.isNamespaceExport(clause)) {
          specifiers.add(spec);
          exports.set(clause.name.text, {
            kind: "alias",
            key: keyOf(spec, WHOLE),
            spec,
          });
        } else {
          for (const e of clause.elements) {
            exports.set(e.name.text, {
              kind: "alias",
              key: keyOf(spec, (e.propertyName ?? e.name).text),
              spec,
            });
          }
        }
      } else if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const e of clause.elements) {
          exports.set(e.name.text, {
            kind: "local",
            local: (e.propertyName ?? e.name).text,
          });
        }
      }
      return;
    }
    if (ts.isExportAssignment(st)) {
      const name = st.isExportEquals ? "export=" : "default";
      if (ts.isIdentifier(st.expression)) {
        exports.set(name, { kind: "local", local: st.expression.text });
      } else {
        const local = `\0${name}`;
        bindDecl(local, idx);
        exports.set(name, { kind: "local", local });
      }
      return;
    }
    // Declarations.
    const declared: string[] = [];
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) declared.push(d.name.text);
      }
    } else if (
      (ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isFunctionDeclaration(st) ||
        ts.isEnumDeclaration(st) ||
        ts.isModuleDeclaration(st)) &&
      st.name !== undefined &&
      ts.isIdentifier(st.name)
    ) {
      declared.push(st.name.text);
    } else if (
      (ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st)) &&
      st.name === undefined
    ) {
      declared.push("\0default");
    } else {
      // `declare global`, `declare module "x"`, `export {}`: a global file's
      // business (its version is in the global hash), or nothing.
      return;
    }
    const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
    for (const name of declared) {
      bindDecl(name, idx);
      if (exported && isDefault) {
        exports.set("default", { kind: "local", local: name });
      } else if (exported) exports.set(name, { kind: "local", local: name });
    }
  });

  // A local exported under some name is referenced through that name (an
  // edge), not inlined into its referrer's text.
  const exportedAs = new Map<string, string>();
  for (const [name, e] of exports) {
    if (e.kind === "local" && !exportedAs.has(e.local)) {
      exportedAs.set(e.local, name);
    }
  }

  const names: Record<string, NameRec> = {};
  for (const [name, e] of exports) {
    if (e.kind === "alias") {
      names[name] = {
        t: sha(`alias\0${e.key ?? `dep:${e.spec}`}`),
        d: e.key === undefined ? [] : [e.key],
        i: [],
      };
      continue;
    }
    const top = bindings.get(e.local);
    if (top !== undefined && top.kind === "import") {
      names[name] = {
        t: sha(`alias\0${top.key ?? `dep:${top.spec}`}`),
        d: top.key === undefined ? [] : [top.key],
        i: [],
      };
      continue;
    }
    const texts: string[] = [];
    const deps = new Set<string>();
    const seenStmt = new Set<number>();
    const seenLocal = new Set<string>([e.local]);
    const visitLocal = (local: string, root: boolean): void => {
      const b = bindings.get(local);
      if (b === undefined) return; // a global, a type parameter, a member name
      if (b.kind === "import") {
        if (b.key !== undefined) deps.add(b.key);
        return;
      }
      if (!root) {
        const as = exportedAs.get(local);
        if (as !== undefined) {
          deps.add(nameKey(self, as));
          return;
        }
      }
      for (const s of b.stmts) {
        if (seenStmt.has(s)) continue;
        seenStmt.add(s);
        texts.push(stmtText[s]!);
        for (const k of stmtImportTypes[s]!) deps.add(k);
        for (const r of stmtRefs[s]!) {
          if (seenLocal.has(r)) continue;
          seenLocal.add(r);
          visitLocal(r, false);
        }
      }
    };
    visitLocal(e.local, true);
    deps.delete(nameKey(self, name));
    names[name] = {
      t: sha(`local\0${[...texts].sort().join("\n")}`),
      d: [...deps].sort(),
      i: [],
    };
  }
  return { names, star: [...star].sort(), specifiers: [...specifiers].sort() };
}
