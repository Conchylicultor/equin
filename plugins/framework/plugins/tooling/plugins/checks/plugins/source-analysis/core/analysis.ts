import type TS from "typescript";
import { fileTargetUses, type TargetUse } from "./file-uses";
import {
  cannotRead,
  read,
  siteOf,
  unreadableAt,
  type Collected,
  type ParsedFile,
  type Readout,
  type SourceSite,
} from "./result";

// The cross-file half: modules resolved by the repo project's own compiler
// options (`ts.resolveModuleName` over the run's file set — never a
// hand-written `@plugins/` rewrite), exports followed through every barrel
// spelling, an identifier taken to its declaration, and the uses of a target
// declaration gathered across the files that can name it. Syntax only: every
// question here is a binding question, answered exactly without a checker
// (`research/2026-11-12-global-check-source-analysis.md`).

/** A module (repo-relative file) and one of its export names. */
export interface ExportRef {
  rel: string;
  name: string;
}

/** A declaration: the node that introduces a value binding, in its file. */
export interface Declaration {
  file: ParsedFile;
  name: string;
  /**
   * The declaring node: a `VariableDeclaration`, `FunctionDeclaration`,
   * `ClassDeclaration`, `EnumDeclaration`, `Parameter`, `BindingElement`, a
   * `CatchClause` variable, or an `ExportAssignment` (`export default <expr>`).
   */
  node: TS.Node;
  site: SourceSite;
}

/** What a name is bound to once every import and re-export is followed. */
export type Binding =
  | { kind: "declaration"; declaration: Declaration }
  /** A whole module (`import * as ns`, `export * as ns`). */
  | { kind: "namespace"; rel: string }
  /** Something that is not the repo's code: an npm package, or a JSON data module. */
  | { kind: "external"; specifier: string }
  /**
   * Declared nowhere in its file, imported from nowhere: a global of the
   * runtime (`Date`, `console`) — or a name tsc would refuse. Only
   * {@link SourceAnalysis.bindingOf} answers it; a module export never is one.
   */
  | { kind: "global"; name: string };

export type ModuleResolution =
  { kind: "repo"; rel: string } | { kind: "external" } | { kind: "missing" };

/** Reads repo files by repo-relative path — a check's `ctx.repo()`. */
export interface SourceFiles {
  has(rel: string): boolean;
  read(rel: string): Promise<string | null>;
}

export interface SourceAnalysisHost {
  ts: typeof TS;
  files: SourceFiles;
  /** Parse one file (parent pointers set) — a check passes `parsedTsSource`, which yields the check thread. */
  parse(source: { rel: string; src: string }): Promise<TS.SourceFile>;
  /** The repo project's compiler options ({@link readRepoCompilerOptions}). */
  compilerOptions: TS.CompilerOptions;
}

/**
 * Selects the candidate files whose text matches a `git grep -E` pattern — a
 * check passes `(grepArg) => listCandidateSources({ grepArg })`.
 */
export type CandidatesFor = (
  grepArg: string,
) => Promise<ReadonlyArray<{ rel: string; src: string }>>;

export interface SourceAnalysis {
  /** The file `specifier` names from `fromRel`, as the repo project resolves it. */
  resolveModule(fromRel: string, specifier: string): ModuleResolution;
  /** One parsed repo file, or null when it is not in the set. */
  file(rel: string): Promise<ParsedFile | null>;
  /** What `rel`'s export `name` is bound to, through re-exports, `export *` and import-then-export. */
  exportedBinding(rel: string, name: string): Promise<Readout<Binding>>;
  /**
   * What `id` refers to, in its innermost scope, then the file's imports
   * followed to their declaration; `global` when the file neither declares
   * nor imports it.
   */
  bindingOf(file: ParsedFile, id: TS.Identifier): Promise<Readout<Binding>>;
  /** A `const`'s initializer; any other declaration (let, var, parameter, destructured, function) is Unreadable. */
  initializerOf(declaration: Declaration): Readout<TS.Expression>;
  /**
   * Every use of each target across the repo: the files that can name it are
   * selected through `candidatesFor` (every name it is exported under, found
   * by following its re-exports to a fixpoint, plus every namespace import),
   * and each is read by {@link fileTargetUses} with imports resolved through
   * every barrel. Fail-closed: what cannot be read is in `unreadable`.
   */
  usesOf<K extends string>(
    targets: Readonly<Record<K, ExportRef>>,
    candidatesFor: CandidatesFor,
  ): Promise<Collected<TargetUse<K>>>;
}

/** The root a repo-relative path is anchored at for the compiler's resolver (no file is read through it). */
const ROOT = "/repo";

/**
 * The compiler options of the repo project — the root `tsconfig.json` (the ONE
 * project, `repoProgram`) with its `extends` chain — parsed by TypeScript
 * itself over files read from `files`, anchored for {@link createSourceAnalysis}.
 */
export async function readRepoCompilerOptions(
  ts: typeof TS,
  files: SourceFiles,
  tsconfigRel = "tsconfig.json",
): Promise<TS.CompilerOptions> {
  const texts = new Map<string, string>();
  const pending = [tsconfigRel];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    if (texts.has(rel)) continue;
    const text = await files.read(rel);
    if (text === null) throw new Error(`${rel}: tsconfig not found`);
    texts.set(rel, text);
    const { config, error } = ts.parseConfigFileTextToJson(rel, text);
    if (error !== undefined)
      throw new Error(
        `${rel}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`,
      );
    const ext: unknown = (config as { extends?: unknown }).extends;
    for (const e of typeof ext === "string"
      ? [ext]
      : Array.isArray(ext)
        ? ext
        : []) {
      if (typeof e !== "string" || !e.startsWith("."))
        throw new Error(
          `${rel}: extends ${String(e)} — only a relative tsconfig is read`,
        );
      pending.push(joinRel(dirnameRel(rel), e));
    }
  }
  const strip = (p: string) => p.slice(ROOT.length + 1);
  const host: TS.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (p) => texts.has(strip(p)),
    readFile: (p) => texts.get(strip(p)),
  };
  const json = ts.parseConfigFileTextToJson(
    tsconfigRel,
    texts.get(tsconfigRel)!,
  ).config;
  const parsed = ts.parseJsonConfigFileContent(
    json,
    host,
    ROOT,
    undefined,
    `${ROOT}/${tsconfigRel}`,
  );
  // 18003: "No inputs were found" — the host lists no directory; the roots are not what is read here.
  const errors = parsed.errors.filter((d) => d.code !== 18003);
  if (errors.length > 0)
    throw new Error(
      errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("\n"),
    );
  return parsed.options;
}

export function createSourceAnalysis(host: SourceAnalysisHost): SourceAnalysis {
  const { ts, files, compilerOptions } = host;
  const modules = new Map<string, Promise<ParsedFile | null>>();
  const exports = new Map<string, Promise<Readout<Binding> | null>>();
  const resolutions = new Map<string, ModuleResolution>();
  const aliasPrefixes = Object.keys(compilerOptions.paths ?? {}).map((k) =>
    k.replace(/\*.*$/, ""),
  );
  const namespaceImport = namespaceImportPattern(aliasPrefixes);

  const resolutionHost: TS.ModuleResolutionHost = {
    fileExists: (p) => {
      if (!p.startsWith(`${ROOT}/`)) return false;
      const rel = p.slice(ROOT.length + 1);
      return !rel.split("/").includes("node_modules") && files.has(rel);
    },
    readFile: () => undefined,
  };

  const resolveModule = (
    fromRel: string,
    specifier: string,
  ): ModuleResolution => {
    const key = `${dirnameRel(fromRel)}\0${specifier}`;
    let hit = resolutions.get(key);
    if (hit === undefined) {
      const resolved = ts.resolveModuleName(
        specifier,
        `${ROOT}/${fromRel}`,
        compilerOptions,
        resolutionHost,
      ).resolvedModule;
      if (
        resolved !== undefined &&
        resolved.resolvedFileName.startsWith(`${ROOT}/`)
      )
        hit = {
          kind: "repo",
          rel: resolved.resolvedFileName.slice(ROOT.length + 1),
        };
      else if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        aliasPrefixes.some(
          (p) => specifier === p || (p !== "" && specifier.startsWith(p)),
        )
      )
        hit = { kind: "missing" };
      else hit = { kind: "external" };
      resolutions.set(key, hit);
    }
    return hit;
  };

  const seed = (rel: string, src: string): Promise<ParsedFile | null> => {
    let pending = modules.get(rel);
    if (pending === undefined) {
      pending = host.parse({ rel, src }).then((sf) => ({ rel, sf }));
      modules.set(rel, pending);
    }
    return pending;
  };

  const file = (rel: string): Promise<ParsedFile | null> => {
    let pending = modules.get(rel);
    if (pending === undefined) {
      pending = (files.has(rel) ? files.read(rel) : Promise.resolve(null)).then(
        (src) =>
          src === null
            ? null
            : host.parse({ rel, src }).then((sf) => ({ rel, sf })),
      );
      modules.set(rel, pending);
    }
    return pending;
  };

  const declaration = (
    f: ParsedFile,
    name: string,
    node: TS.Node,
  ): Readout<Binding> =>
    read({
      kind: "declaration",
      declaration: { file: f, name, node, site: siteOf(f, node) },
    });

  /** `specifier`'s export `name`, seen from `from`; a named re-export that names nothing is Unreadable. */
  const viaSpecifier = async (
    from: ParsedFile,
    specifier: string,
    name: string,
    at: TS.Node,
    stack: ReadonlySet<string>,
  ): Promise<Readout<Binding>> => {
    const m = resolveModule(from.rel, specifier);
    if (m.kind === "external") return read({ kind: "external", specifier });
    if (m.kind === "missing")
      return cannotRead(
        from,
        at,
        `"${specifier}" resolves to no file of the repo.`,
      );
    // A JSON module is data, not code: nothing it binds can be followed.
    if (m.rel.endsWith(".json")) return read({ kind: "external", specifier });
    if (name === "*") return read({ kind: "namespace", rel: m.rel });
    const found = await exportIn(m.rel, name, stack);
    return (
      found ??
      cannotRead(
        from,
        at,
        `"${specifier}" has no export \`${name}\` this analysis can find.`,
      )
    );
  };

  /** What top-level `name` of `f` is bound to (a declaration or an import), or null when it declares none. */
  const topLevel = async (
    f: ParsedFile,
    name: string,
    stack: ReadonlySet<string>,
  ): Promise<Readout<Binding> | null> => {
    for (const stmt of f.sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const clause = stmt.importClause;
        if (clause === undefined || clause.isTypeOnly) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const spec = stmt.moduleSpecifier.text;
        if (clause.name?.text === name)
          return viaSpecifier(f, spec, "default", clause, stack);
        const b = clause.namedBindings;
        if (b === undefined) continue;
        if (ts.isNamespaceImport(b)) {
          if (b.name.text === name) return viaSpecifier(f, spec, "*", b, stack);
          continue;
        }
        for (const el of b.elements)
          if (!el.isTypeOnly && el.name.text === name)
            return viaSpecifier(
              f,
              spec,
              (el.propertyName ?? el.name).text,
              el,
              stack,
            );
        continue;
      }
      const found = declaredIn(ts, [stmt], name, false);
      if (found !== null) return declaration(f, name, found);
    }
    return null;
  };

  /** `rel`'s export `name`, or null when the module does not export it. */
  const exportIn = async (
    rel: string,
    name: string,
    stack: ReadonlySet<string>,
  ): Promise<Readout<Binding> | null> => {
    const key = `${rel}\0${name}`;
    if (stack.has(key)) return null; // an `export *` cycle adds nothing
    const top = stack.size === 0;
    if (top) {
      const hit = exports.get(key);
      if (hit !== undefined) return hit;
    }
    const work = (async (): Promise<Readout<Binding> | null> => {
      const f = await file(rel);
      if (f === null) return null;
      const inner = new Set(stack).add(key);
      const stars: TS.ExportDeclaration[] = [];
      for (const stmt of f.sf.statements) {
        if (ts.isExportDeclaration(stmt)) {
          if (stmt.isTypeOnly) continue;
          const spec =
            stmt.moduleSpecifier !== undefined &&
            ts.isStringLiteral(stmt.moduleSpecifier)
              ? stmt.moduleSpecifier.text
              : undefined;
          const clause = stmt.exportClause;
          if (clause === undefined) {
            if (spec !== undefined) stars.push(stmt);
            continue;
          }
          if (ts.isNamespaceExport(clause)) {
            if (clause.name.text === name && spec !== undefined)
              return viaSpecifier(f, spec, "*", clause, inner);
            continue;
          }
          for (const el of clause.elements) {
            if (el.isTypeOnly || el.name.text !== name) continue;
            const orig = (el.propertyName ?? el.name).text;
            if (spec !== undefined)
              return viaSpecifier(f, spec, orig, el, inner);
            return (
              (await topLevel(f, orig, inner)) ??
              cannotRead(
                f,
                el,
                `exports \`${orig}\`, which this file does not declare or import.`,
              )
            );
          }
          continue;
        }
        if (ts.isExportAssignment(stmt)) {
          if (name !== "default" || stmt.isExportEquals) continue;
          if (ts.isIdentifier(stmt.expression))
            return (
              (await topLevel(f, stmt.expression.text, inner)) ??
              cannotRead(
                f,
                stmt,
                `default-exports \`${stmt.expression.text}\`, which this file does not declare.`,
              )
            );
          return declaration(f, "default", stmt);
        }
        if (!hasModifier(ts, stmt, ts.SyntaxKind.ExportKeyword)) continue;
        if (name === "default") {
          if (
            hasModifier(ts, stmt, ts.SyntaxKind.DefaultKeyword) &&
            (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt))
          )
            return declaration(f, "default", stmt);
          continue;
        }
        if (hasModifier(ts, stmt, ts.SyntaxKind.DefaultKeyword)) continue;
        // A destructured export (`export const { a } = obj`) is a declaration
        // too: its node is the BindingElement, whose value `initializerOf`
        // refuses to read.
        const found = declaredIn(ts, [stmt], name, false);
        if (found !== null) return declaration(f, name, found);
      }
      if (name === "default") return null;
      for (const star of stars) {
        const m = resolveModule(
          rel,
          (star.moduleSpecifier as TS.StringLiteral).text,
        );
        if (m.kind !== "repo") continue;
        const found = await exportIn(m.rel, name, inner);
        if (found !== null) return found;
      }
      return null;
    })();
    if (top) exports.set(key, work);
    return work;
  };

  const exportedBinding = async (
    rel: string,
    name: string,
  ): Promise<Readout<Binding>> => {
    const found = await exportIn(rel, name, new Set());
    if (found !== null) return found;
    const f = await file(rel);
    if (f === null)
      throw new Error(`exportedBinding: ${rel} is not a repo file`);
    return cannotRead(
      f,
      f.sf,
      `\`${rel}\` has no export \`${name}\` this analysis can find.`,
    );
  };

  const bindingOf = async (
    f: ParsedFile,
    id: TS.Identifier,
  ): Promise<Readout<Binding>> => {
    const name = id.text;
    for (
      let node: TS.Node = id.parent;
      !ts.isSourceFile(node);
      node = node.parent
    ) {
      const found = declaredInScope(ts, node, name);
      if (found !== null) return declaration(f, name, found);
    }
    const top = await topLevel(f, name, new Set());
    if (top !== null) return top;
    // A `var` hoisted out of a top-level block is the file's own.
    const hoisted = declaredIn(ts, f.sf.statements, name, true);
    if (hoisted !== null) return declaration(f, name, hoisted);
    // `global` only for a name the file truly does not declare: one it
    // declares in a form not followed here is unreadable, never a global.
    for (const stmt of f.sf.statements)
      if (
        (ts.isImportEqualsDeclaration(stmt) || ts.isModuleDeclaration(stmt)) &&
        ts.isIdentifier(stmt.name) &&
        stmt.name.text === name
      )
        return cannotRead(
          f,
          id,
          `\`${name}\` is declared by \`import = require\` or a \`namespace\`, which this analysis does not follow — import it by name.`,
        );
    return read({ kind: "global", name });
  };

  const initializerOf = (d: Declaration): Readout<TS.Expression> => {
    const n = d.node;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0 &&
      n.initializer !== undefined
    )
      return read(n.initializer);
    return cannotRead(
      d.file,
      n,
      `\`${d.name}\` is not a \`const\` with an initializer, so its value cannot be read from its declaration.`,
    );
  };

  const usesOf = async <K extends string>(
    targets: Readonly<Record<K, ExportRef>>,
    candidatesFor: CandidatesFor,
  ): Promise<Collected<TargetUse<K>>> => {
    const out: Collected<TargetUse<K>> = { found: [], unreadable: [] };
    const keyOf = new Map<string, K>();
    const declaring = new Map<string, Map<string, K>>(); // file → top-level name → key
    const spellings = new Set<string>();
    // Names a NAMESPACE of a module exporting a target is exported under
    // (`export * as ns`): a file importing one by name is selected and refused.
    const namespaceSpellings = new Set<string>();
    const exportsTarget = async (rel: string): Promise<boolean> => {
      for (const s of spellings)
        if (targetOf(await exportIn(rel, s, new Set())) !== undefined)
          return true;
      return false;
    };
    for (const key of Object.keys(targets) as K[]) {
      const ref = targets[key];
      const b = await exportedBinding(ref.rel, ref.name);
      if (b.kind !== "read" || b.value.kind !== "declaration")
        throw new Error(
          `usesOf: ${ref.rel} export \`${ref.name}\` is not a declaration in the repo`,
        );
      const d = b.value.declaration;
      keyOf.set(declarationKey(d), key);
      spellings.add(ref.name);
      let names = declaring.get(d.file.rel);
      if (names === undefined) declaring.set(d.file.rel, (names = new Map()));
      names.set(d.name, key);
    }
    const targetOf = (b: Readout<Binding> | null): K | undefined =>
      b?.kind === "read" && b.value.kind === "declaration"
        ? keyOf.get(declarationKey(b.value.declaration))
        : undefined;

    // Every name a target is exported under: a re-export spells the name it
    // re-exports, so each round's candidates hold every next alias.
    const named = (): ReadonlySet<string> =>
      new Set([...spellings, ...namespaceSpellings]);
    let candidates: ReadonlyArray<{ rel: string; src: string }> = [];
    for (;;) {
      candidates = await candidatesFor(
        grepAlternation(named(), namespaceImport),
      );
      const before = spellings.size + namespaceSpellings.size;
      for (const c of candidates) {
        const f = await seed(c.rel, c.src);
        if (f === null) continue;
        for (const name of aliasingExports(ts, f.sf, named())) {
          if (spellings.has(name) || namespaceSpellings.has(name)) continue;
          const b = await exportIn(c.rel, name, new Set());
          if (targetOf(b) !== undefined) spellings.add(name);
          else if (
            b?.kind === "read" &&
            b.value.kind === "namespace" &&
            (await exportsTarget(b.value.rel))
          )
            namespaceSpellings.add(name);
        }
      }
      if (spellings.size + namespaceSpellings.size === before) break;
    }

    for (const c of candidates) {
      const f = await seed(c.rel, c.src);
      if (f === null) continue;
      const bySpec = new Map<string, Map<string, K>>();
      // A dynamic `import("…")` / `require("…")`: whether its module exports a
      // target, so the per-file layer refuses it.
      for (const spec of dynamicSpecifiers(ts, f.sf)) {
        const m = resolveModule(f.rel, spec);
        if (m.kind !== "repo" || bySpec.has(spec)) continue;
        const map = new Map<string, K>();
        for (const name of spellings) {
          const key = targetOf(await exportIn(m.rel, name, new Set()));
          if (key !== undefined) map.set(name, key);
        }
        bySpec.set(spec, map);
      }
      for (const stmt of f.sf.statements) {
        if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)))
          continue;
        const ms = stmt.moduleSpecifier;
        if (ms === undefined || !ts.isStringLiteral(ms)) continue;
        const spec = ms.text;
        // The names this statement can bind a target under. An element can
        // only if it imports one of the names a target is exported under (the
        // fixpoint above found them all — a rename spells both names, so its
        // file was a candidate); a whole module — `import * as`, `export *` —
        // is asked for every one of them, for the reader's isTargetModule.
        // Resolving every element instead parsed every module a candidate
        // imports: ~2k of the check pass's parses, for no answer.
        const known = named();
        const names = new Set<string>();
        const consider = (name: string) => {
          if (known.has(name)) names.add(name);
        };
        if (ts.isImportDeclaration(stmt)) {
          const clause = stmt.importClause;
          if (clause === undefined || clause.isTypeOnly) continue;
          if (clause.name !== undefined) consider("default");
          const b = clause.namedBindings;
          if (b !== undefined && ts.isNamespaceImport(b))
            for (const n of known) names.add(n);
          else if (b !== undefined)
            for (const el of b.elements)
              if (!el.isTypeOnly) consider((el.propertyName ?? el.name).text);
        } else if (stmt.isTypeOnly) continue;
        else if (
          stmt.exportClause !== undefined &&
          ts.isNamedExports(stmt.exportClause)
        ) {
          for (const el of stmt.exportClause.elements)
            if (!el.isTypeOnly) consider((el.propertyName ?? el.name).text);
        } else for (const n of known) names.add(n);
        const m = resolveModule(f.rel, spec);
        if (m.kind === "external") continue;
        if (m.kind === "missing") {
          out.unreadable.push(
            unreadableAt(
              f,
              stmt,
              `"${spec}" resolves to no file of the repo, so whether it names a target cannot be read.`,
            ),
          );
          continue;
        }
        let map = bySpec.get(spec);
        if (map === undefined) bySpec.set(spec, (map = new Map()));
        for (const name of names) {
          const b = await exportIn(m.rel, name, new Set());
          const key = targetOf(b);
          if (key !== undefined) map.set(name, key);
          else if (
            b?.kind === "read" &&
            b.value.kind === "namespace" &&
            !spellings.has(name)
          ) {
            // `import { ns } from "./barrel"` where the barrel has `export * as ns`
            // of a module exporting a target: its members are not followed.
            const nsRel = b.value.rel;
            for (const s of spellings)
              if (targetOf(await exportIn(nsRel, s, new Set())) !== undefined) {
                out.unreadable.push(
                  unreadableAt(
                    f,
                    stmt,
                    `\`${name}\` from "${spec}" is a namespace re-export of a module exporting a target; import the target by name.`,
                  ),
                );
                break;
              }
          }
        }
      }
      const own = declaring.get(f.rel);
      const uses = fileTargetUses<K>(ts, f, {
        imported: (spec, exported) => bySpec.get(spec)?.get(exported),
        isTargetModule: (spec) => (bySpec.get(spec)?.size ?? 0) > 0,
        local: own === undefined ? undefined : (name) => own.get(name),
      });
      out.found.push(...uses.found);
      out.unreadable.push(...uses.unreadable);
    }
    return out;
  };

  return {
    resolveModule,
    file,
    exportedBinding,
    bindingOf,
    initializerOf,
    usesOf,
  };
}

/** One declaration's identity across a run: its file and position. */
export function declarationKey(d: { file: ParsedFile; node: TS.Node }): string {
  return `${d.file.rel}:${d.node.pos}`;
}

/**
 * The `const` an expression initializes — through parentheses, `as`,
 * `satisfies`, `!` and either arm of a conditional (`const x = c ? f() : g()`
 * binds both calls to `x`) — or null when no `const` binds it.
 */
export function boundConst(
  ts: typeof TS,
  file: ParsedFile,
  expr: TS.Expression,
): Declaration | null {
  let n: TS.Node = expr;
  for (;;) {
    const p = n.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== n)
    )
      n = p;
    else break;
  }
  const p = n.parent;
  if (
    ts.isVariableDeclaration(p) &&
    p.initializer === n &&
    ts.isIdentifier(p.name) &&
    ts.isVariableDeclarationList(p.parent) &&
    (p.parent.flags & ts.NodeFlags.Const) !== 0
  )
    return { file, name: p.name.text, node: p, site: siteOf(file, p) };
  return null;
}

/** `a|b|<namespace>`: a file naming any spelling, or namespace-importing a repo module. */
function grepAlternation(
  names: ReadonlySet<string>,
  namespaceImport: string,
): string {
  return [
    ...[...names].map((n) => n.replace(/\$/g, "\\$")),
    namespaceImport,
  ].join("|");
}

/**
 * A `git grep -E` pattern for a line that may namespace-import (or
 * namespace-re-export) a REPO module: `* as x from "<./, /, or a path alias>"`,
 * or a `* as` / `* as x` ending its line (an import split across lines — the
 * pattern cannot see its specifier, so it is selected). A namespace of an npm
 * package (`* as React from "react"`) can never be a target's module, and
 * `\* as ` alone also matched every JSDoc line opening with "as": ~410
 * candidates, 33 of them namespace imports of the repo's own code.
 */
function namespaceImportPattern(aliasPrefixes: readonly string[]): string {
  const sources = [".", "/", ...aliasPrefixes.filter((p) => p !== "")].map(
    (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `\\* as([[:space:]]*$| [A-Za-z0-9_$]+[[:space:]]*$| [A-Za-z0-9_$]+ from ["'](${sources.join("|")}))`;
}

/**
 * The names `sf` exports that can alias a target or a namespace holding one,
 * given the names known to do so: a re-export whose source name is known
 * (`export { known as alias } from`), a local re-export of a known import or of
 * a namespace import (`import * as ns …; export { ns }`), `export * as ns`, and
 * `export default` of such a binding. Every other export (a declaration, a
 * re-export of an unknown name) cannot: a rename spells the name it renames,
 * so the file holding it was selected by that name — the fixpoint finds each
 * alias in the round after its source. Resolving every export of every
 * candidate instead parsed each re-export's module.
 */
function aliasingExports(
  ts: typeof TS,
  sf: TS.SourceFile,
  known: ReadonlySet<string>,
): string[] {
  const imported = new Map<string, string | "*">(); // local → imported name, "*" for a namespace
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) imported.set(clause.name.text, "default");
    const b = clause.namedBindings;
    if (b === undefined) continue;
    if (ts.isNamespaceImport(b)) imported.set(b.name.text, "*");
    else
      for (const el of b.elements)
        if (!el.isTypeOnly)
          imported.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  const aliases = (local: string): boolean => {
    if (known.has(local)) return true;
    const from = imported.get(local);
    return from !== undefined && (from === "*" || known.has(from));
  };
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const c = stmt.exportClause;
      if (c === undefined) continue;
      if (ts.isNamespaceExport(c)) {
        out.push(c.name.text);
        continue;
      }
      for (const el of c.elements) {
        if (el.isTypeOnly) continue;
        const source = (el.propertyName ?? el.name).text;
        if (
          stmt.moduleSpecifier === undefined
            ? aliases(source)
            : known.has(source)
        )
          out.push(el.name.text);
      }
    } else if (
      ts.isExportAssignment(stmt) &&
      !stmt.isExportEquals &&
      ts.isIdentifier(stmt.expression) &&
      aliases(stmt.expression.text)
    )
      out.push("default");
  }
  return out;
}

/** Every string specifier a file loads dynamically: `import("…")`, `require("…")`. */
function dynamicSpecifiers(ts: typeof TS, sf: TS.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    )
      out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hasModifier(
  ts: typeof TS,
  node: TS.Node,
  kind: TS.SyntaxKind,
): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
  );
}

/** The node declaring `name` in a binding name (an identifier, or inside a destructuring pattern). */
function inBindingName(
  ts: typeof TS,
  n: TS.BindingName,
  name: string,
  decl: TS.Node,
): TS.Node | null {
  if (ts.isIdentifier(n)) return n.text === name ? decl : null;
  for (const el of n.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const found = inBindingName(ts, el.name, name, el);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The declaration of `name` among `statements` (functions, classes, enums,
 * variables; with `varsDeep`, also `var`s nested in blocks — hoisted to the
 * enclosing function).
 */
function declaredIn(
  ts: typeof TS,
  statements: readonly TS.Statement[],
  name: string,
  varsDeep: boolean,
): TS.Node | null {
  for (const stmt of statements) {
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name?.text === name
    )
      return stmt;
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations) {
        const found = inBindingName(ts, d.name, name, d);
        if (found !== null) return found;
      }
  }
  if (!varsDeep) return null;
  let hoisted: TS.Node | null = null;
  const visit = (node: TS.Node): void => {
    if (hoisted !== null || ts.isFunctionLike(node) || ts.isClassLike(node))
      return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    )
      for (const d of node.declarations) {
        hoisted ??= inBindingName(ts, d.name, name, d);
      }
    ts.forEachChild(node, visit);
  };
  for (const stmt of statements) ts.forEachChild(stmt, visit);
  return hoisted;
}

/** The declaration of `name` that scope `node` introduces itself, or null. */
function declaredInScope(
  ts: typeof TS,
  node: TS.Node,
  name: string,
): TS.Node | null {
  if (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    const fnBody = ts.isBlock(node) && ts.isFunctionLike(node.parent);
    return declaredIn(ts, node.statements, name, fnBody);
  }
  if (ts.isFunctionLike(node)) {
    for (const p of node.parameters) {
      const found = inBindingName(ts, p.name, name, p);
      if (found !== null) return found;
    }
    if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name?.text === name
    )
      return node;
    return null;
  }
  if (ts.isClassExpression(node) && node.name?.text === name) return node;
  if (
    (ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer)
  )
    for (const d of node.initializer.declarations) {
      const found = inBindingName(ts, d.name, name, d);
      if (found !== null) return found;
    }
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
    return inBindingName(
      ts,
      node.variableDeclaration.name,
      name,
      node.variableDeclaration,
    );
  return null;
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
