/**
 * Which contributed lists can a supervised job's `run` body read? Measured
 * statically for every `run`-body job, at several granularities, to size the
 * design "a job that starts the whole app, or names the lists it reads, should
 * have no spelling" (wiki: Import time and lazy imports, 2026-11-20).
 *
 *   ./equin run plugins/framework/plugins/server-core/scripts/measure-job-read-reach.ts \
 *     [--job <name>] [--json] [--sites] [--why [--level <level>]]
 *
 * Every non-test, non-web module under `plugins/` is parsed once (syntax only):
 * its imports and re-exports, its top-level declarations with the names each
 * one uses, the lists it defines (`defineServerContribution`) and its whole
 * reads (`List.getContributions()`, a job's `read(List)`). Then, per job, the
 * lists a start rule would make the job's process start the contributors of,
 * to a fixpoint (a started contributor can bring further reads):
 *
 *   run          names followed from the `run` body only; reading a list also
 *                follows the code of its entries (the arguments of each
 *                `List(…)` contribution). The recommended rule.
 *   run+top      the same, plus the top-level statements of every module a
 *                followed name lives in.
 *   run+hooks    `run`, plus the `onReadyBlocking` hook of every started plugin.
 *   binding      names followed from the whole `defineSupervisedJob(…)` call
 *                (the parent's supervising code included).
 *   binding+boot `binding`, plus every started plugin's whole definition.
 *   module       every list read anywhere in a module the started plugins load.
 *   owner        every list defined in a module the started plugins load.
 *
 * `nodes` is the start set the resolver gives for those lists (plugin halves,
 * before host-service providers and sink handlers, which only a load finds):
 * measure the real start with `scripts/exec-boot-cost.ts --start
 * <plugin> --reads <lists>`. `--why` prints, per list, the chain of names that
 * reached it; `--sites` every whole read in the repo with its list.
 *
 * A measurement, not the build's derivation: lists made by a wrapper or a
 * factory (`Object.assign(fn, token)`, `defineHostService`) are not resolved
 * and show as `genericReadSites`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { resolveSpecifier } from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";
import ts from "typescript";
import { serverEntries } from "../core/server.generated";
import { machineEntries } from "../core/machine.generated";
import { serverContributors } from "../core/contributors.generated";
import { graphNodeOf, resolveStartSet } from "../core/start-set";
import { isMachineNode } from "@plugins/framework/plugins/plugin-id/core";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};

// ── Files ────────────────────────────────────────────────────────────────────

const listed = spawnSync("git", ["ls-files", "plugins"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 1 << 28,
}).stdout.split("\n");
const isCode = (p: string) =>
  /\.(ts|tsx)$/.test(p) &&
  !/\.test\.tsx?$/.test(p) &&
  !/\.d\.ts$/.test(p) &&
  !p.includes("/__tests__/") &&
  !p.includes("/testing/") &&
  !/\/(web|e2e|exhibits|vite|lint|check|scripts|bin|facet|guard)\//.test(p);
const files = new Set(listed.filter(isCode));

const resolveSpec = (from: string, spec: string): string | null =>
  resolveSpecifier(from, spec, (rel) => files.has(rel));

// ── Per-file facts ───────────────────────────────────────────────────────────

type Ref = { root: string; path: string[] }; // identifier + member chain
interface Decl {
  name: string;
  refs: Ref[]; // every identifier (with its member chain) used inside
  dynImports: string[];
}
interface Facts {
  file: string;
  imports: Map<string, { target: string | null; exported: string }>; // local → source
  namespaces: Map<string, string | null>;
  valueImports: Set<string>; // module-level edges (resolved files)
  reexports: { target: string | null; exported: string; as: string }[];
  starExports: (string | null)[];
  localExports: Map<string, string>; // exported name → local name
  decls: Map<string, Decl>;
  top: Decl; // top-level statements that are not declarations
  tokens: {
    local: string;
    path: string[];
    debug: string | null;
    partial: boolean;
    data: boolean;
  }[];
  dynamicTokenDefs: number;
  jobs: { decl: string; name: string; wholeApp: boolean }[];
  reads: {
    decl: string;
    recv: Ref | null;
    text: string;
    line: number;
    method: string;
  }[];
  calls: { decl: string; callee: Ref; argRefs: Ref[] }[]; // every call with a ref callee
}

const READ_METHODS = new Set([
  "getContributions",
  "getContributionsIfCollected",
]);

function refOf(node: ts.Expression): Ref | null {
  const path: string[] = [];
  let cur: ts.Expression = node;
  while (
    ts.isPropertyAccessExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    if (ts.isPropertyAccessExpression(cur)) path.unshift(cur.name.text);
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? { root: cur.text, path } : null;
}

function scan(file: string): Facts {
  const src = readFileSync(join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const f: Facts = {
    file,
    imports: new Map(),
    namespaces: new Map(),
    valueImports: new Set(),
    reexports: [],
    starExports: [],
    localExports: new Map(),
    decls: new Map(),
    top: { name: "<top>", refs: [], dynImports: [] },
    tokens: [],
    dynamicTokenDefs: 0,
    jobs: [],
    reads: [],
    calls: [],
  };
  const edge = (spec: string) => {
    const t = resolveSpec(file, spec);
    if (t !== null) f.valueImports.add(t);
    return t;
  };
  const walk = (decl: Decl, node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (
      !decl.name.includes("@") &&
      decl.name !== "@args" &&
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const call = node.parent.parent;
      if (
        node.name.text === "run" &&
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "defineSupervisedJob"
      )
        walk(declOf(`${decl.name}@run`), node);
      if (node.name.text === "onReadyBlocking" && decl.name === "default")
        walk(declOf("default@boot"), node);
    }
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const t = resolveSpec(file, node.arguments[0].text);
        if (t !== null) decl.dynImports.push(t);
      }
      const callee = node.expression;
      if (decl.name === "@args") {
        // refs only
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        READ_METHODS.has(callee.name.text)
      ) {
        f.reads.push({
          decl: decl.name,
          recv: refOf(callee.expression),
          text: callee.expression.getText(sf),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          method: callee.name.text,
        });
      } else if (
        ((ts.isIdentifier(callee) && callee.text === "read") ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "read" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "ctx")) &&
        node.arguments.length === 1 &&
        refOf(node.arguments[0]!) !== null
      ) {
        f.reads.push({
          decl: decl.name,
          recv: refOf(node.arguments[0]!),
          text: node.arguments[0]!.getText(sf),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          method: "read",
        });
      } else {
        const r = refOf(callee);
        if (r !== null) {
          const sub: Decl = { name: "@args", refs: [], dynImports: [] };
          for (const a of node.arguments) walk(sub, a);
          f.calls.push({ decl: decl.name, callee: r, argRefs: sub.refs });
        }
      }
    }
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node);
      if (!isName) {
        // climb the member chain this identifier roots
        let top: ts.Expression = node;
        const path: string[] = [];
        while (
          ts.isPropertyAccessExpression(top.parent) &&
          top.parent.expression === top
        ) {
          path.push(top.parent.name.text);
          top = top.parent;
        }
        decl.refs.push({ root: node.text, path });
      }
    }
    ts.forEachChild(node, (c) => walk(decl, c));
  };
  function declOf(name: string): Decl {
    let d = f.decls.get(name);
    if (d === undefined) {
      d = { name, refs: [], dynImports: [] };
      f.decls.set(name, d);
    }
    return d;
  }
  const isExported = (n: ts.Node) =>
    (ts.getCombinedModifierFlags(n as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0;
  const findTokens = (local: string, init: ts.Expression, path: string[]) => {
    let e = init;
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e)
    )
      e = e.expression;
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c) && c.text === "defineServerContribution") {
        const a0 = e.arguments[0];
        const a1 = e.arguments[1];
        const optText = a1?.getText(sf) ?? "";
        f.tokens.push({
          local,
          path,
          debug:
            a0 !== undefined && ts.isStringLiteralLike(a0) ? a0.text : null,
          partial: /\bpartial\s*:/.test(optText),
          data: /\bdata\s*:\s*true/.test(optText),
        });
      }
    } else if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
          findTokens(local, p.initializer, [...path, p.name.text]);
      }
    }
  };
  const findJob = (local: string, init: ts.Expression) => {
    if (
      !ts.isCallExpression(init) ||
      !ts.isIdentifier(init.expression) ||
      init.expression.text !== "defineSupervisedJob"
    )
      return;
    const spec = init.arguments[0];
    if (spec === undefined || !ts.isObjectLiteralExpression(spec)) return;
    const prop = (name: string) =>
      spec.properties.find(
        (p) =>
          p.name !== undefined &&
          ts.isIdentifier(p.name) &&
          p.name.text === name,
      );
    const name = prop("name");
    if (
      prop("run") === undefined ||
      name === undefined ||
      !ts.isPropertyAssignment(name) ||
      !ts.isStringLiteralLike(name.initializer)
    )
      return;
    f.jobs.push({
      decl: local,
      name: name.initializer.text,
      wholeApp: prop("wholeApp") !== undefined,
    });
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause === undefined) {
        edge(spec);
        continue;
      }
      if (clause.isTypeOnly) continue;
      let value = false;
      const target = resolveSpec(file, spec);
      if (clause.name !== undefined) {
        f.imports.set(clause.name.text, { target, exported: "default" });
        value = true;
      }
      const b = clause.namedBindings;
      if (b !== undefined) {
        if (ts.isNamespaceImport(b)) {
          f.namespaces.set(b.name.text, target);
          value = true;
        } else {
          for (const el of b.elements) {
            if (el.isTypeOnly) continue;
            f.imports.set(el.name.text, {
              target,
              exported: (el.propertyName ?? el.name).text,
            });
            value = true;
          }
        }
      }
      if (value) edge(spec);
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.moduleSpecifier !== undefined) {
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const target = edge(stmt.moduleSpecifier.text);
        if (stmt.exportClause === undefined) f.starExports.push(target);
        else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.isTypeOnly) continue;
            f.reexports.push({
              target,
              exported: (el.propertyName ?? el.name).text,
              as: el.name.text,
            });
          }
        }
      } else if (
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          f.localExports.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          if (d.initializer !== undefined) walk(f.top, d.initializer);
          continue;
        }
        const decl = declOf(d.name.text);
        if (isExported(stmt)) f.localExports.set(d.name.text, d.name.text);
        if (d.initializer !== undefined) {
          findJob(d.name.text, d.initializer);
          walk(decl, d.initializer);
          findTokens(d.name.text, d.initializer, []);
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      const decl = declOf(stmt.name.text);
      const flags = ts.getCombinedModifierFlags(stmt);
      if (flags & ts.ModifierFlags.Export) {
        f.localExports.set(
          flags & ts.ModifierFlags.Default ? "default" : stmt.name.text,
          stmt.name.text,
        );
      }
      ts.forEachChild(stmt, (c) => walk(decl, c));
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      const decl = declOf("default");
      f.localExports.set("default", "default");
      walk(decl, stmt.expression);
      continue;
    }
    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    )
      continue;
    walk(f.top, stmt);
  }
  // token defs not bound at top level (factories)
  const all = (src.match(/\bdefineServerContribution\s*[<(]/g) ?? []).length;
  f.dynamicTokenDefs = Math.max(0, all - f.tokens.length);
  return f;
}

const facts = new Map<string, Facts>();
const scanT0 = performance.now();
const scanCpu0 = process.cpuUsage();
for (const file of files) facts.set(file, scan(file));
const scanMs = Math.round(performance.now() - scanT0);
const scanCpuMs = Math.round(
  (process.cpuUsage(scanCpu0).user + process.cpuUsage(scanCpu0).system) / 1000,
);

// ── Resolution ───────────────────────────────────────────────────────────────

type Node = string; // `${file}#${decl}`
const nodeId = (file: string, decl: string): Node => `${file}#${decl}`;

/** The declaring (file, local) of `name` as exported by `file`. */
function resolveExport(
  file: string | null,
  name: string,
  seen = new Set<string>(),
): { file: string; local: string } | null {
  if (file === null) return null;
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const f = facts.get(file);
  if (f === undefined) return null;
  const local = f.localExports.get(name);
  if (local !== undefined) return resolveLocal(file, local, seen);
  for (const r of f.reexports) {
    if (r.as === name) return resolveExport(r.target, r.exported, seen);
  }
  for (const t of f.starExports) {
    const hit = resolveExport(t, name, seen);
    if (hit !== null) return hit;
  }
  return null;
}
function resolveLocal(
  file: string,
  local: string,
  seen = new Set<string>(),
): { file: string; local: string } | null {
  const f = facts.get(file)!;
  if (f.decls.has(local)) return { file, local };
  const imp = f.imports.get(local);
  if (imp !== undefined) return resolveExport(imp.target, imp.exported, seen);
  return null;
}
/** Resolve a ref in `file` to a declaration, consuming a namespace hop. */
function resolveRef(
  file: string,
  ref: Ref,
): { file: string; local: string; path: string[] } | null {
  const f = facts.get(file)!;
  const ns = f.namespaces.get(ref.root);
  if (ns !== undefined) {
    if (ref.path.length === 0) return null;
    const hit = resolveExport(ns, ref.path[0]!);
    return hit === null ? null : { ...hit, path: ref.path.slice(1) };
  }
  const hit = resolveLocal(file, ref.root);
  return hit === null ? null : { ...hit, path: ref.path };
}

// Tokens: key `${file}#${local}.${path}`
interface Token {
  key: string;
  file: string;
  debug: string | null;
  partial: boolean;
  data: boolean;
}
const tokens = new Map<string, Token>();
const tokensOfDecl = new Map<Node, Token[]>();
for (const f of facts.values()) {
  for (const t of f.tokens) {
    const key = `${f.file}#${t.local}${t.path.map((p) => `.${p}`).join("")}`;
    const tok = {
      key,
      file: f.file,
      debug: t.debug,
      partial: t.partial,
      data: t.data,
    };
    tokens.set(key, tok);
    const n = nodeId(f.file, t.local);
    tokensOfDecl.set(n, [...(tokensOfDecl.get(n) ?? []), tok]);
  }
}
function tokenOfRef(file: string, ref: Ref): Token | null {
  const hit = resolveRef(file, ref);
  if (hit === null) return null;
  // longest member-path prefix naming a token
  for (let n = hit.path.length; n >= 0; n--) {
    const key = `${hit.file}#${hit.local}${hit.path
      .slice(0, n)
      .map((p) => `.${p}`)
      .join("")}`;
    const t = tokens.get(key);
    if (t !== undefined) return t;
  }
  return null;
}

// Read sites → token (or generic)
interface ReadSite {
  file: string;
  decl: string;
  line: number;
  text: string;
  token: Token | null;
}
const readSites: ReadSite[] = [];
for (const f of facts.values()) {
  for (const r of f.reads) {
    readSites.push({
      file: f.file,
      decl: r.decl,
      line: r.line,
      text: r.text,
      token: r.recv === null ? null : tokenOfRef(f.file, r.recv),
    });
  }
}
const generic = readSites.filter((s) => s.token === null);

/** Is a list one whose whole read matters to a partial process? */
const guarded = (t: Token) => !t.partial && !t.data && t.debug !== null;

// A module "mentions" a token when it references it other than to contribute
// (a call `Token(...)`): the conservative reading that also covers a token
// handed to generic code.
const mentions = new Map<string, Set<Token>>(); // file → tokens
const contributionArgs = new Map<string, Node[]>(); // token key → decl nodes holding a contribution call
for (const f of facts.values()) {
  const callsByDecl = new Map<string, Ref[]>();
  for (const c of f.calls) {
    callsByDecl.set(c.decl, [...(callsByDecl.get(c.decl) ?? []), c.callee]);
    const t = tokenOfRef(f.file, c.callee);
    if (t !== null) {
      // exact token call = a contribution
      const hit = resolveRef(f.file, c.callee)!;
      const exact =
        `${hit.file}#${hit.local}${hit.path.map((p) => `.${p}`).join("")}` ===
        t.key;
      if (exact) {
        const seeds = contributionArgs.get(t.key) ?? [];
        for (const ref of c.argRefs) {
          const h = resolveRef(f.file, ref);
          if (h !== null) seeds.push(nodeId(h.file, h.local));
        }
        contributionArgs.set(t.key, seeds);
      }
    }
  }
  const all = [...f.decls.values(), f.top];
  for (const d of all) {
    for (const ref of d.refs) {
      const t = tokenOfRef(f.file, ref);
      if (t === null) continue;
      const hit = resolveRef(f.file, ref)!;
      const exact =
        `${hit.file}#${hit.local}${hit.path.map((p) => `.${p}`).join("")}` ===
        t.key;
      const isContribution =
        exact &&
        (callsByDecl.get(d.name) ?? []).some(
          (c) => c.root === ref.root && c.path.join(".") === ref.path.join("."),
        );
      if (isContribution || t.file === f.file) continue;
      let set = mentions.get(f.file);
      if (set === undefined) mentions.set(f.file, (set = new Set()));
      set.add(t);
    }
  }
}

// ── Graphs ───────────────────────────────────────────────────────────────────

function moduleClosure(seeds: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const f = facts.get(file);
    if (f === undefined) continue;
    seen.add(file);
    for (const t of f.valueImports) queue.push(t);
    for (const d of [...f.decls.values(), f.top])
      for (const t of d.dynImports) queue.push(t);
  }
  return seen;
}

const parentOf = new Map<Node, Node>();
function chainOf(n: Node): string[] {
  const out = [n];
  let cur = n;
  while (parentOf.has(cur) && out.length < 40) {
    cur = parentOf.get(cur)!;
    out.push(cur);
  }
  return out;
}
let withTop = false;
function bindingClosure(seeds: Iterable<Node>): Set<Node> {
  const seen = new Set<Node>();
  parentOf.clear();
  const queue: [Node, Node | null][] = [...seeds].map((s) => [s, null]);
  let curNode: Node | null = null;
  const push = (file: string, decl: string) =>
    queue.push([nodeId(file, decl), curNode]);
  while (queue.length > 0) {
    const [n, from] = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (from !== null) parentOf.set(n, from);
    curNode = n;
    const [file, declName] = n.split("#") as [string, string];
    const f = facts.get(file);
    if (f === undefined) continue;
    if (withTop && declName !== "<top>") push(file, "<top>");
    const d = declName === "<top>" ? f.top : f.decls.get(declName);
    if (d === undefined) continue;
    for (const ref of d.refs) {
      const ns = f.namespaces.get(ref.root);
      if (ns !== undefined && ref.path.length === 0 && ns !== null) {
        // the namespace as a value: every export of the target
        const tf = facts.get(ns);
        if (tf !== undefined)
          for (const local of tf.localExports.values()) push(ns, local);
        continue;
      }
      const hit = resolveRef(file, ref);
      if (hit !== null) push(hit.file, hit.local);
    }
    for (const t of d.dynImports) {
      const tf = facts.get(t);
      if (tf === undefined) continue;
      push(t, "<top>");
      for (const local of tf.localExports.values()) push(t, local);
    }
  }
  return seen;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const entries = [...serverEntries, ...machineEntries];
const byNode = new Map(entries.map((e) => [graphNodeOf(e), e]));
const barrelOf = (node: string): string => {
  const e = byNode.get(node)!;
  return `plugins/${e.pluginPath}/${isMachineNode(e.id) ? "machine" : "server"}/index.ts`;
};
const debugToToken = new Map<string, Token>();
for (const t of tokens.values())
  if (t.debug !== null) debugToToken.set(t.debug, t);

interface Job {
  name: string;
  file: string;
  decl: string;
  plugin: string;
  wholeApp: boolean;
}
const jobs: Job[] = [];
for (const f of facts.values()) {
  for (const j of f.jobs) {
    const plugin = /^plugins\/(.+)\/(server|machine)\//.exec(f.file)?.[1];
    if (plugin !== undefined) jobs.push({ ...j, file: f.file, plugin });
  }
}
jobs.sort((a, b) => a.name.localeCompare(b.name));

const allNodes = new Set(byNode.keys());
function startSet(root: string, reads: readonly string[]): Set<string> {
  // host services, sinks and companions need a load to discover; the caller
  // measures the final set with measure-job-slice / exec-boot-cost.
  const set = resolveStartSet({
    entries,
    roots: [root],
    reads,
    contributors: serverContributors,
  });
  return new Set(set.why.keys());
}

type Level =
  | "owner"
  | "module"
  | "binding+boot"
  | "binding"
  | "run"
  | "run+hooks"
  | "run+top";

function derive(job: Job, level: Level) {
  let reads = new Set<string>();
  let started = new Set<string>();
  let rounds = 0;
  for (;;) {
    rounds++;
    started = startSet(job.plugin, [...reads]);
    const loaded = moduleClosure([...started].map(barrelOf));
    const next = new Set<string>();
    if (level === "owner") {
      for (const t of tokens.values())
        if (guarded(t) && loaded.has(t.file)) next.add(t.debug!);
    } else if (level === "module") {
      for (const s of readSites)
        if (s.token !== null && guarded(s.token) && loaded.has(s.file))
          next.add(s.token.debug!);
    } else {
      const seeds: Node[] = [
        nodeId(
          job.file,
          level.startsWith("run") ? `${job.decl}@run` : job.decl,
        ),
      ];
      if (level === "binding+boot") {
        for (const n of started) seeds.push(nodeId(barrelOf(n), "default"));
      }
      if (level === "run+hooks") {
        for (const n of started)
          seeds.push(nodeId(barrelOf(n), "default@boot"));
      }
      // reading a list reaches its entries' code
      for (const debug of reads) {
        const t = debugToToken.get(debug);
        if (t !== undefined) seeds.push(...(contributionArgs.get(t.key) ?? []));
      }
      withTop = level === "run+top";
      const reached = bindingClosure(seeds);
      withTop = false;
      if (flag("--why") && level === (opt("--level") ?? "run")) {
        for (const s of readSites)
          if (
            s.token !== null &&
            guarded(s.token) &&
            reached.has(nodeId(s.file, s.decl))
          )
            console.log(
              `\n== ${s.token.debug} @ ${s.file}:${s.line}\n   ` +
                chainOf(nodeId(s.file, s.decl))
                  .map((c) =>
                    c.replace(/^plugins\//, "").replace(/\/plugins\//g, "/"),
                  )
                  .join("\n   <- "),
            );
      }
      for (const s of readSites)
        if (
          s.token !== null &&
          guarded(s.token) &&
          reached.has(nodeId(s.file, s.decl))
        )
          next.add(s.token.debug!);
    }
    const before = reads.size;
    for (const r of next) reads.add(r);
    if (reads.size === before) {
      const genericLoaded = generic.filter((s) => loaded.has(s.file)).length;
      return {
        reads: [...reads].sort(),
        nodes: started.size,
        rounds,
        genericLoaded,
      };
    }
  }
}

const only = opt("--job");
const out: Record<string, unknown> = {};
const summary = {
  files: files.size,
  tokens: tokens.size,
  guardedTokens: [...tokens.values()].filter(guarded).length,
  partialTokens: [...tokens.values()].filter((t) => t.partial).length,
  dataTokens: [...tokens.values()].filter((t) => t.data).length,
  factoryTokenDefs: [...facts.values()].reduce(
    (a, f) => a + f.dynamicTokenDefs,
    0,
  ),
  readSites: readSites.length,
  genericReadSites: generic.map((s) => `${s.file}:${s.line} ${s.text}`),
  registryNodes: allNodes.size,
  scanMs,
  scanCpuMs,
};
for (const job of jobs) {
  if (only !== undefined && job.name !== only) continue;
  const row: Record<string, unknown> = {
    plugin: job.plugin,
    wholeApp: job.wholeApp,
  };
  for (const level of [
    "run",
    "run+top",
    "run+hooks",
    "binding",
    "binding+boot",
    "module",
    "owner",
  ] as Level[])
    row[level] = derive(job, level);
  out[job.name] = row;
}
if (flag("--sites")) {
  for (const s of readSites)
    console.log(
      `${s.token?.debug ?? "?"}\t${s.token === null ? "generic" : guarded(s.token) ? "complete" : s.token.partial ? "partial" : "data"}\t${s.file}:${s.line}\t${s.decl}`,
    );
} else if (flag("--json")) {
  console.log(JSON.stringify({ summary, jobs: out }, null, 1));
} else {
  console.log(JSON.stringify(summary, null, 1));
  for (const [name, row] of Object.entries(out)) {
    const r = row as Record<string, { reads: string[]; nodes: number }> & {
      plugin: string;
      wholeApp: boolean;
    };
    console.log(
      `\n${name}  (${r.plugin})${r.wholeApp ? "  [wholeApp today]" : ""}`,
    );
    for (const level of [
      "run",
      "run+top",
      "run+hooks",
      "binding",
      "binding+boot",
      "module",
      "owner",
    ]) {
      const d = r[level]!;
      console.log(
        `  ${level.padEnd(13)} ${String(d.nodes).padStart(4)} nodes, ${String(d.reads.length).padStart(3)} lists${d.reads.length <= 12 ? `: ${d.reads.join(", ")}` : ""}`,
      );
    }
  }
}
