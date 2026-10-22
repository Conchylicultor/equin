// The type check's ENGINE and its two formats: what every result key folds
// in besides a file's text and the declarations it sees (`tscEngineFp`), how a
// diagnostic is printed, and the canonical form of a `.d.ts` that signatures
// and per-name records are read from.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";
import { sha256 } from "./keys";
import { lockfileLintDigest } from "./lockfile";

const rel = (root: string, abs: string): string =>
  relative(root, abs).split("\\").join("/");

export function formatDiagnostic(root: string, d: ts.Diagnostic): string {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${rel(root, d.file.fileName)}:${line + 1}:${character + 1} - error TS${d.code}: ${msg}`;
  }
  return `error TS${d.code}: ${msg}`;
}

/**
 * The ENGINE every key folds in (through the global hash, `./name-run.ts`): what decides a
 * file's diagnostics besides its own text and the declarations it sees. The
 * compiler and its options (paths relative to the root, so every worktree
 * shares one key), the npm resolutions (`lockfileLintDigest`: a contract edge
 * into a dependency is dropped, so a dependency's own types move every key
 * through here), dependency patches, and this engine's own code.
 */
export function tscEngineFp(root: string, options: ts.CompilerOptions): string {
  const parts: string[] = [`typescript ${ts.version}`];
  parts.push(
    `options ${JSON.stringify(options, (_k, v: unknown) =>
      typeof v === "string" && v.startsWith(root)
        ? `<root>${v.slice(root.length)}`
        : v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : v,
    )}`,
  );
  const lock = join(root, "bun.lock");
  parts.push(
    `lock ${existsSync(lock) ? lockfileLintDigest(readFileSync(lock, "utf8")) : "-"}`,
  );
  const patches = join(root, "patches");
  if (existsSync(patches)) {
    for (const entry of readdirSync(patches, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort()) {
      parts.push(
        `patch ${rel(root, entry)} ${sha256(readFileSync(entry, "utf8"))}`,
      );
    }
  }
  parts.push(`code ${sourcesFp(producerSources())}`);
  return sha256(parts.join("\n"));
}

/** The hash of some of this directory's sources, by name and content. */
export function sourcesFp(files: readonly string[]): string {
  return sha256(
    files
      .map(
        (own) =>
          `source ${own} ${sha256(readFileSync(join(import.meta.dir, own), "utf8"))}`,
      )
      .join("\n"),
  );
}

/**
 * The modules that PRODUCE what the store keeps under a result key: a file's
 * check (diagnostics, the `.d.ts` and its canonical form), its per-name
 * records, imports and resolutions, the program's host, and the store's own
 * format — the import closure, inside this directory, of `PRODUCERS`.
 * Derived from the imports, never listed, so a module the producer starts
 * importing is in it the moment it is.
 *
 * Only these move the global hash. The walk, the bases and the run's plumbing
 * (`name-walk`, `walk-*`, `run-base`, `name-run`) decide WHICH stored results
 * are read and under what key: an edit that changes a key's formula misses
 * by itself, and every other one is held by the replay oracle and the
 * backstop — so editing them re-checks nothing, it only re-walks
 * (`engineSources`, which keys the walk base).
 */
export function producerSources(): string[] {
  const seen = new Set<string>();
  const stack = [...PRODUCERS];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(join(import.meta.dir, f), "utf8");
    for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
      const m = /^\.\/([^/]+?)(\.ts)?$/.exec(imp.fileName);
      if (m !== null) stack.push(`${m[1]}.ts`);
    }
  }
  return [...seen].sort();
}

/**
 * The roots of the producer closure: the per-file check and its records
 * (`name-check`), the store and its format (`name-store`), and the options
 * every program is built with (`emit-options`).
 */
const PRODUCERS = ["name-check.ts", "name-store.ts", "emit-options.ts"];

/**
 * This engine's code: what decides a key, a walk, a check, and a `.d.ts` —
 * every top-level source of `shared/` but the worker's process plumbing and
 * the dual-mode oracle. It keys the WALK BASE (`./walk-base.ts`): a base
 * written by other walk code is not walked from. Listed from the directory,
 * never by hand: a new module the check reads would otherwise fall out of the
 * key in silence. (Which is why new files go FLAT in `shared/`.)
 */
export function engineSources(): string[] {
  return readdirSync(import.meta.dir)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !NOT_ENGINE.has(f),
    )
    .sort();
}

const NOT_ENGINE = new Set(["worker.ts", "full-check.ts"]);

/**
 * A `.d.ts` in a canonical form: every type literal's PROPERTY signatures in
 * name order, and every union's members in text order. tsc's printed order is
 * not always a function of the code, even with `stableTypeOrdering`: it
 * orders unions of anonymous object types, and the properties normalization
 * adds to them (`task?: undefined`), by what the checker had resolved before.
 * Measured: 11 of 12k files printed differently checked in walk order vs tsc's
 * order, and 6 more over 31 replayed main commits. A property's position in a
 * type literal, and a member's in a union, mean nothing, so sorting them only
 * removes the noise; method and call signatures keep their relative order, and
 * intersections theirs, since overload resolution reads both.
 *
 * And every type reference through an import binding spelled as the import
 * type it names: `Rank` under `import { Rank } from "s"` is `import("s").Rank`.
 * Declaration emit picks either spelling for one type depending on where the
 * type came from: one a dependency's `.d.ts` spelled out is copied as written,
 * one inferred from its source is printed through the local binding. So a
 * file checked against served `.d.ts` and the same file in one whole program
 * print the same type two ways (measured: `pageBlocksServed`'s `rank`,
 * replaying main's abd05b5fe7). An import declaration no reference is left
 * using is dropped. A name some type parameter in the file declares is left
 * alone (it may shadow the binding).
 */
export function canonicalDeclarations(dts: string): string {
  const sf = ts.createSourceFile(
    "contract.d.ts",
    dts,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter();
  const nameOf = (m: ts.PropertySignature): string =>
    ts.isIdentifier(m.name) ||
    ts.isStringLiteral(m.name) ||
    ts.isNumericLiteral(m.name)
      ? m.name.text
      : printer.printNode(ts.EmitHint.Unspecified, m.name, sf);
  // Each import binding: the module and the name it imports (`default`, or
  // null for a namespace import).
  const bindings = new Map<string, { spec: string; name: string | null }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (clause.name) bindings.set(clause.name.text, { spec, name: "default" });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      bindings.set(nb.name.text, { spec, name: null });
    } else if (nb) {
      for (const el of nb.elements) {
        bindings.set(el.name.text, {
          spec,
          name: (el.propertyName ?? el.name).text,
        });
      }
    }
  }
  const shadowed = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(node)) shadowed.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (const n of shadowed) bindings.delete(n);
  /** `B`, `B.X`, `NS.X.Y` through a binding: [binding, qualifier after it]. */
  const split = (
    n: ts.EntityName,
  ): { head: string; rest: string[] } | undefined => {
    const rest: string[] = [];
    let cur: ts.EntityName = n;
    while (ts.isQualifiedName(cur)) {
      rest.unshift(cur.right.text);
      cur = cur.left;
    }
    return bindings.has(cur.text) ? { head: cur.text, rest } : undefined;
  };
  /** A name a declaration, member or property access gives, not a reference. */
  const declaredName = (
    id: ts.Identifier,
    parent: ts.Node | undefined,
  ): boolean => {
    if (parent === undefined) return false;
    if (ts.isQualifiedName(parent)) return parent.right === id;
    if (ts.isPropertyAccessExpression(parent)) return parent.name === id;
    if (ts.isExportSpecifier(parent)) {
      // `export { local as exported }`: only `local` refers to a binding.
      return parent.propertyName !== undefined && parent.name === id;
    }
    return (parent as { name?: ts.Node }).name === id;
  };
  const qualifyImports: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const f = context.factory;
    const importType = (
      n: ts.EntityName,
      typeArguments: readonly ts.TypeNode[] | undefined,
      isTypeOf: boolean,
    ): ts.ImportTypeNode | undefined => {
      const at = split(n);
      if (at === undefined) return undefined;
      const b = bindings.get(at.head)!;
      const path = b.name === null ? at.rest : [b.name, ...at.rest];
      // A bare namespace import (`typeof NS`) has no name to qualify by.
      if (path.length === 0) return undefined;
      let q: ts.EntityName = f.createIdentifier(path[0]!);
      for (const part of path.slice(1)) q = f.createQualifiedName(q, part);
      return f.createImportTypeNode(
        f.createLiteralTypeNode(f.createStringLiteral(b.spec)),
        undefined,
        q,
        typeArguments,
        isTypeOf,
      );
    };
    const visit = (node: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isTypeReferenceNode(visited)) {
        return (
          importType(visited.typeName, visited.typeArguments, false) ?? visited
        );
      }
      if (ts.isTypeQueryNode(visited)) {
        return (
          importType(visited.exprName, visited.typeArguments, true) ?? visited
        );
      }
      return visited;
    };
    return (root) => {
      const out = ts.visitNode(root, visit) as ts.SourceFile;
      // The bindings still referenced (an export specifier, a heritage
      // clause, a value position) keep their import; the others go.
      const used = new Set<string>();
      const see = (node: ts.Node, parent: ts.Node | undefined): void => {
        if (ts.isImportDeclaration(node)) return;
        // An import type's qualifier names the module's export, not a binding.
        if (ts.isImportTypeNode(node)) {
          for (const a of node.typeArguments ?? []) see(a, node);
          return;
        }
        if (ts.isIdentifier(node) && !declaredName(node, parent)) {
          used.add(node.text);
        }
        ts.forEachChild(node, (child) => see(child, node));
      };
      see(out, undefined);
      const statements: ts.Statement[] = [];
      for (const st of out.statements) {
        if (
          !ts.isImportDeclaration(st) ||
          st.importClause === undefined ||
          !ts.isStringLiteral(st.moduleSpecifier)
        ) {
          statements.push(st);
          continue;
        }
        const c = st.importClause;
        const keepName = c.name && used.has(c.name.text) ? c.name : undefined;
        let nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb) && !used.has(nb.name.text)) {
          nb = undefined;
        } else if (nb && ts.isNamedImports(nb)) {
          const kept = nb.elements.filter((e) => used.has(e.name.text));
          nb = kept.length > 0 ? f.updateNamedImports(nb, kept) : undefined;
        }
        if (keepName === undefined && nb === undefined) continue;
        statements.push(
          f.updateImportDeclaration(
            st,
            st.modifiers,
            f.updateImportClause(c, c.isTypeOnly, keepName, nb),
            st.moduleSpecifier,
            st.attributes,
          ),
        );
      }
      return f.updateSourceFile(out, statements);
    };
  };
  const sortMembers: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isUnionTypeNode(visited)) {
        const types = visited.types
          .map((t) => ({
            t,
            text: printer.printNode(ts.EmitHint.Unspecified, t, sf),
          }))
          .sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
          .map(({ t }) => t);
        return context.factory.updateUnionTypeNode(
          visited,
          context.factory.createNodeArray(types),
        );
      }
      if (!ts.isTypeLiteralNode(visited)) return visited;
      const props = visited.members
        .filter(ts.isPropertySignature)
        .map((m) => ({ m, name: nameOf(m) }))
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
        .map(({ m }) => m);
      const rest = visited.members.filter((m) => !ts.isPropertySignature(m));
      return context.factory.updateTypeLiteralNode(
        visited,
        context.factory.createNodeArray([...rest, ...props]),
      );
    };
    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };
  const result = ts.transform(sf, [qualifyImports, sortMembers]);
  const text = printer.printFile(result.transformed[0]!);
  result.dispose();
  return text;
}
