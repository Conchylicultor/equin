/**
 * Measures what "importing every plugin definition" would cost if a plugin's
 * main file loaded only what it needs to DECLARE, with every implementation
 * behind a lazy reference (design check of 2026-11-20, task-1795208483-6ggeec).
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/import-closure/scripts/measure-definition-closure.ts \
 *     --host server|web [--policy B|A] [--state <dir>] [--step all|discover|strict|timed|baseline|bundle] [--runs 5]
 *
 * How: a Bun loader plugin rewrites every repo module so each import binding
 * is a lazy reference. A reference only PASSED along (a component handed to a
 * list, a handler handed to an endpoint) never loads its module; one that is
 * called or read while a main file evaluates does. Rounds:
 *
 *   discover  tolerant stubs that record what was touched and forward to the
 *             real value; untouched top-level references that resolve to data
 *             (not a function / component) are kept too. Repeats until stable.
 *   strict    stubs that throw when touched: proves the kept set is enough,
 *             and writes the rewritten sources.
 *   timed     imports the whole registry from those sources; CPU of the import.
 *   baseline  the same import loop on untouched code.
 *   bundle    (web) the kept closure as one minified file, brotli size, with
 *             and without npm packages.
 *
 * Policies: `B` (floor) keeps an import only if it was touched at load, so an
 * import used only inside functions is lazy; `A` (automatic) also keeps every
 * import a loaded module's own functions use, so only code handed to a
 * definition is cut.
 *
 * Children import nothing of the repo statically, so no real module is loaded
 * before the loader plugin is installed. Measures the main composition's
 * committed registries; state defaults to `$EQUIN_SCRATCH/definition-closure-<host>-<policy>`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import ts from "typescript";

const REPO = REPO_ROOT;
const arg = (n: string, d?: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1]! : (d as string);
};
const HOST = arg("--host", "server") as "server" | "web";
const POLICY = arg("--policy", "B") as "A" | "B";
const STATE = arg(
  "--state",
  join(
    process.env.EQUIN_SCRATCH ?? ".",
    `definition-closure-${HOST}-${POLICY}`,
  ),
);
const MODE = arg("--child", "");

const ASSET_RE =
  /\.(css|png|jpe?g|svg|gif|webp|avif|woff2?|ttf|mp3|wav|ogg|mp4|webm|json|jsonc|md|txt|sql|html|wasm|glsl|xml|mid|musicxml)(\?.*)?$/;

const CSS_RE = /\.css(\?.*)?$/;
const MEDIA_RE =
  /\.(png|jpe?g|svg|gif|webp|avif|mp3|wav|ogg|mp4|webm|woff2?)(\?.*)?$/;
const MEDIA_STUB = `export default {url:"",src:"",width:1,height:1};`;
const REPO_SOURCE_RE = /\/plugins\/.*\.(ts|tsx|mts)$/;

// ── static scan ─────────────────────────────────────────────────────────────

const exportNamesCache = new Map<string, string[]>();
type Resolved =
  { kind: "file"; path: string } | { kind: "unresolved"; reason: string };

/** The runtime's own resolution: what the process under measurement will load. */
function resolveSpec(spec: string, from: string): Resolved {
  try {
    return { kind: "file", path: Bun.resolveSync(spec, dirname(from)) };
  } catch (err) {
    return { kind: "unresolved", reason: String(err) };
  }
}
function parse(path: string, code: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}
function hasMod(n: ts.Node, k: ts.SyntaxKind): boolean {
  return (
    (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some(
      (m) => m.kind === k,
    ) ?? false
  );
}
function exportNamesOf(path: string, seen = new Set<string>()): string[] {
  const hit = exportNamesCache.get(path);
  if (hit) return hit;
  if (seen.has(path)) return [];
  seen.add(path);
  if (path.includes("/node_modules/") || !/\.(ts|tsx|mts)$/.test(path)) {
    return [];
  }
  const sf = parse(path, readFileSync(path, "utf8"));
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (!st.exportClause) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        const r = resolveSpec(spec, path);
        if (r.kind === "file")
          for (const n of exportNamesOf(r.path, seen)) out.add(n);
      } else if (ts.isNamespaceExport(st.exportClause)) {
        out.add(st.exportClause.name.text);
      } else {
        for (const el of st.exportClause.elements)
          if (!el.isTypeOnly) out.add(el.name.text);
      }
    } else if (ts.isExportAssignment(st)) {
      out.add("default");
    } else if (hasMod(st, ts.SyntaxKind.ExportKeyword)) {
      if (hasMod(st, ts.SyntaxKind.DeclareKeyword)) continue;
      if (hasMod(st, ts.SyntaxKind.DefaultKeyword)) {
        out.add("default");
        continue;
      }
      if (ts.isVariableStatement(st)) {
        const walk = (b: ts.BindingName): void => {
          if (ts.isIdentifier(b)) out.add(b.text);
          else
            for (const e of b.elements)
              if (!ts.isOmittedExpression(e)) walk(e.name);
        };
        for (const d of st.declarationList.declarations) walk(d.name);
      } else if (
        (ts.isFunctionDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name
      ) {
        out.add(st.name.text);
      }
    }
  }
  out.delete("default");
  const res = [...out];
  exportNamesCache.set(path, res);
  return res;
}

/** identifier names referenced in value positions: at top level / inside a function body */
interface Occ {
  s: number;
  e: number;
  name: string;
  shorthand: boolean;
}
function refs(sf: ts.SourceFile): {
  top: Set<string>;
  fn: Set<string>;
  occ: Occ[];
  declared: Set<string>;
} {
  const top = new Set<string>();
  const fn = new Set<string>();
  const occ: Occ[] = [];
  const declared = new Set<string>();
  const visit = (n: ts.Node, depth: number): void => {
    if (ts.isExpressionWithTypeArguments(n)) {
      visit(n.expression, depth);
      return;
    }
    if (
      ts.isImportDeclaration(n) ||
      ts.isTypeNode(n) ||
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n)
    )
      return;
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isMethodDeclaration(p) && p.name === n) ||
        (ts.isPropertyDeclaration(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        (ts.isJsxAttribute(p) && p.name === n) ||
        (ts.isExportSpecifier(p) &&
          p.propertyName !== undefined &&
          p.name === n)
      )
        return;
      if (
        ((ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p)) &&
          p.name === n) ||
        ((ts.isFunctionDeclaration(p) ||
          ts.isFunctionExpression(p) ||
          ts.isClassDeclaration(p) ||
          ts.isClassExpression(p) ||
          ts.isEnumDeclaration(p)) &&
          p.name === n)
      ) {
        declared.add(n.text);
        return;
      }
      (depth > 0 ? fn : top).add(n.text);
      if (depth > 0)
        occ.push({
          s: n.getStart(sf),
          e: n.end,
          name: n.text,
          shorthand: ts.isShorthandPropertyAssignment(p),
        });
      return;
    }
    let d = depth;
    if (
      ts.isFunctionLike(n) ||
      (ts.isPropertyDeclaration(n) && !hasMod(n, ts.SyntaxKind.StaticKeyword))
    )
      d++;
    ts.forEachChild(n, (c) => visit(c, d));
  };
  visit(sf, 0);
  return { top, fn, occ, declared };
}

// ── transform ───────────────────────────────────────────────────────────────

type KeepFn = (key: string) => boolean;
const demands: { target: string; name: string }[] = [];
const reexports = new Map<
  string,
  { key: string; target: string; imported: string }[]
>();
function propagate(keepSet: Set<string>, into: Set<string>): void {
  const seen = new Set<string>();
  const queue = [...demands];
  while (queue.length) {
    const d = queue.pop()!;
    const id = `${d.target}|${d.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const hits =
      d.name === "*"
        ? [...reexports.entries()]
            .filter(([k]) => k.startsWith(`${d.target}|`))
            .flatMap(([, v]) => v)
        : (reexports.get(id) ?? []);
    for (const h of hits) {
      if (!keepSet.has(h.key)) into.add(h.key);
      queue.push({ target: h.target, name: h.imported });
    }
  }
}
const q = JSON.stringify;

function transform(
  path: string,
  code: string,
  keep: KeepFn,
  bundle: boolean,
): string {
  const sf = parse(path, code);
  const { top, fn, occ, declared } = refs(sf);
  const getters: string[] = [];
  const lazyFn = new Set<string>();
  const rel = path.startsWith(REPO) ? path.slice(REPO.length + 1) : path;
  const edits: { s: number; e: number; t: string }[] = [];
  let n = 0;
  const lz = (
    key: string,
    spec: string,
    imported: string,
    flags: number,
  ): string =>
    bundle
      ? `__lz(${q(key)})`
      : `__lz(${q(key)},()=>require(${q(spec)}),${q(imported)},${flags})`;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (ASSET_RE.test(spec)) continue;
      const binds: { imported: string; local: string }[] = [];
      if (clause.name)
        binds.push({ imported: "default", local: clause.name.text });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb))
        binds.push({ imported: "*", local: nb.name.text });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          if (!el.isTypeOnly)
            binds.push({
              imported: (el.propertyName ?? el.name).text,
              local: el.name.text,
            });
      const parts: string[] = [];
      const kept: string[] = [];
      let keptDefault: string | null = null;
      let keptNs: string | null = null;
      const lazy: string[] = [];
      for (const b of binds) {
        const hasTop = top.has(b.local);
        const hasFn = fn.has(b.local);
        if (!hasTop && !hasFn) continue; // type-only use: elided
        const key = `${rel}|${spec}|${b.imported}`;
        const k =
          keep(key) ||
          (POLICY === "A" && hasFn) ||
          (hasFn && declared.has(b.local));
        if (k) {
          const tgt = resolveSpec(spec, path);
          if (tgt.kind === "file")
            demands.push({ target: tgt.path, name: b.imported });
          if (b.imported === "default") keptDefault = b.local;
          else if (b.imported === "*") keptNs = b.local;
          else
            kept.push(
              b.imported === b.local ? b.local : `${b.imported} as ${b.local}`,
            );
        } else {
          if (hasTop) lazy.push(`${b.local}=${lz(key, spec, b.imported, 1)}`);
          if (hasFn) {
            lazyFn.add(b.local);
            getters.push(
              bundle
                ? `${q(b.local)}:[${q(key)}]`
                : `${q(b.local)}:[${q(key)},()=>require(${q(spec)}),${q(b.imported)}]`,
            );
          }
        }
      }
      if (keptNs) parts.push(`import * as ${keptNs} from ${q(spec)};`);
      if (keptDefault || kept.length > 0)
        parts.push(
          `import ${[keptDefault, kept.length ? `{${kept.join(",")}}` : null].filter(Boolean).join(",")} from ${q(spec)};`,
        );
      if (lazy.length) parts.push(`const ${lazy.join(",")};`);
      edits.push({ s: st.getStart(sf), e: st.end, t: parts.join(" ") });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (ASSET_RE.test(spec)) continue;
      const binds: { imported: string; exported: string }[] = [];
      if (!st.exportClause) {
        const r = resolveSpec(spec, path);
        // `export *` of a package, or of nothing resolvable, stays as written.
        if (r.kind !== "file" || r.path.includes("/node_modules/")) continue;
        for (const name of exportNamesOf(r.path))
          binds.push({ imported: name, exported: name });
      } else if (ts.isNamespaceExport(st.exportClause)) {
        binds.push({ imported: "*", exported: st.exportClause.name.text });
      } else {
        for (const el of st.exportClause.elements)
          if (!el.isTypeOnly)
            binds.push({
              imported: (el.propertyName ?? el.name).text,
              exported: el.name.text,
            });
      }
      const parts: string[] = [];
      const resolved = resolveSpec(spec, path);
      const tgt = resolved.kind === "file" ? resolved.path : spec;
      for (const b of binds) {
        const key = `${rel}|${spec}|${b.imported}`;
        const id = `${path}|${b.exported}`;
        if (!reexports.has(id)) reexports.set(id, []);
        reexports.get(id)!.push({ key, target: tgt, imported: b.imported });
        if (keep(key)) {
          parts.push(
            b.imported === "*"
              ? `export * as ${b.exported} from ${q(spec)};`
              : `export {${b.imported} as ${b.exported}} from ${q(spec)};`,
          );
        } else {
          const v = `__rx${n++}`;
          parts.push(
            `const ${v}=${lz(key, spec, b.imported, 4)}; export {${v} as ${b.exported}};`,
          );
        }
      }
      edits.push({ s: st.getStart(sf), e: st.end, t: parts.join(" ") });
    }
  }
  for (const o of occ)
    if (lazyFn.has(o.name))
      edits.push({
        s: o.s,
        e: o.e,
        t: o.shorthand ? `${o.name}: __L.${o.name}` : `__L.${o.name}`,
      });
  edits.sort((a, b) => b.s - a.s);
  let out = code;
  for (const e of edits) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  if (getters.length) out = `const __L=__lzo({${getters.join(",")}});` + out;
  out += "\nexport {};";
  return out;
}

// ── runtime stubs ───────────────────────────────────────────────────────────

interface Meta {
  key: string;
  load: () => Record<string, unknown>;
  name: string;
  flags: number;
  done?: boolean;
  v?: unknown;
}
const metas = new WeakMap<object, Meta>();
const allStubs: object[] = [];
const touched = new Set<string>();
let phase: "main" | "classify" = "main";
const mainTouched = new Set<string>();

function resolveStub(m: Meta, mark: boolean, chain?: string[]): unknown {
  chain?.push(m.key);
  if (mark) {
    touched.add(m.key);
    if (phase === "main") mainTouched.add(m.key);
  }
  if (!m.done) {
    const ns = m.load();
    m.v = m.name === "*" ? ns : ns[m.name];
    m.done = true;
  }
  let v = m.v;
  const inner =
    typeof v === "function" || (typeof v === "object" && v !== null)
      ? metas.get(v)
      : undefined;
  if (inner) v = resolveStub(inner, mark, chain);
  return v;
}
const BUILTIN = [Map, Set, WeakMap, WeakSet, Date, RegExp, Promise, URL, Array];
function installStubs(strict: boolean): void {
  const handler: ProxyHandler<object> = {};
  const real = (t: object): unknown => {
    const m = metas.get(proxyOf.get(t)!)!;
    if (strict) {
      touched.add(m.key);
      throw new Error(`STUB TOUCHED ${m.key}`);
    }
    return resolveStub(m, true);
  };
  const obj = (v: unknown): object => Object(v) as object;
  handler.get = (t, p) => {
    const r = real(t);
    if (r === null || r === undefined) return undefined;
    const prim = typeof r !== "object" && typeof r !== "function";
    if (p === Symbol.toPrimitive && prim) return () => r;
    const v = Reflect.get(obj(r), p, obj(r)) as unknown;
    if (
      typeof v === "function" &&
      (prim ||
        (BUILTIN.some((B) => r instanceof B) && !Array.isArray(r)) ||
        (typeof r === "object" && !("prototype" in v)))
    )
      return (v as (...a: unknown[]) => unknown).bind(r);
    return v;
  };
  handler.set = (t, p, v) => Reflect.set(obj(real(t)), p, v);
  handler.has = (t, p) => Reflect.has(obj(real(t)), p);
  handler.apply = (t, th, a) =>
    Reflect.apply(real(t) as (...x: unknown[]) => unknown, th, a);
  handler.construct = (t, a, nt) => {
    const r = real(t) as new (...x: unknown[]) => object;
    return Reflect.construct(r, a, nt === proxyOf.get(t) ? r : nt);
  };
  handler.ownKeys = (t) => {
    const k = Reflect.ownKeys(obj(real(t)));
    for (const tk of Reflect.ownKeys(t)) if (!k.includes(tk)) k.push(tk);
    return k;
  };
  handler.getOwnPropertyDescriptor = (t, p) => {
    const d = Reflect.getOwnPropertyDescriptor(obj(real(t)), p);
    const td = Reflect.getOwnPropertyDescriptor(t, p);
    if (td && !td.configurable) return td;
    if (d) d.configurable = true;
    return d;
  };
  handler.getPrototypeOf = (t) => Reflect.getPrototypeOf(obj(real(t)));
  const proxyOf = new WeakMap<object, object>();
  (globalThis as Record<string, unknown>).__lzo = (
    defs: Record<string, [string, () => Record<string, unknown>, string]>,
  ) => {
    const o = {};
    for (const [local, [key, load, name]] of Object.entries(defs)) {
      const m: Meta = { key, load, name, flags: 2 };
      Object.defineProperty(o, local, {
        get() {
          if (strict) {
            touched.add(key);
            throw new Error(`STUB TOUCHED ${key}`);
          }
          return resolveStub(m, true);
        },
      });
    }
    return o;
  };
  (globalThis as Record<string, unknown>).__lz = (
    key: string,
    load: () => Record<string, unknown>,
    name: string,
    flags: number,
  ) => {
    const target = function () {};
    const p = new Proxy(target, handler);
    proxyOf.set(target, p);
    metas.set(p, { key, load, name, flags });
    allStubs.push(p);
    return p;
  };
}

function isCode(v: unknown): boolean {
  if (typeof v === "function") return true;
  if (typeof v === "object" && v !== null && "$$typeof" in v) return true;
  return false;
}

const unclassified: string[] = [];

/** After the main phase: untouched stubs resolving to non-code values are data the definitions hold. */
function classify(): number {
  phase = "classify";
  let added = 0;
  for (let i = 0; i < allStubs.length; i++) {
    const m = metas.get(allStubs[i]!)!;
    if (touched.has(m.key) && mainTouched.has(m.key)) continue;
    if ((m.flags & 1) === 0) continue; // only top-level references are classified
    let v: unknown;
    const chain: string[] = [];
    try {
      v = resolveStub(m, false, chain);
    } catch (err) {
      // A module that cannot load under tolerant stubs: its binding stays
      // lazy, counted in the report; the strict round is the proof either way.
      unclassified.push(`${m.key}: ${String(err).slice(0, 120)}`);
      continue;
    }
    if (v === undefined || isCode(v)) continue;
    for (const k of chain)
      if (!mainTouched.has(k)) {
        mainTouched.add(k);
        added++;
      }
  }
  return added;
}

// ── child ───────────────────────────────────────────────────────────────────

function fakeDom(): void {
  const noop = (): void => {};
  const g = globalThis as Record<string, unknown>;
  const fakeEl = (): unknown => ({
    style: {},
    setAttribute: noop,
    addEventListener: noop,
    appendChild: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  });
  g.window = {
    location: {
      protocol: "http:",
      host: "localhost",
      hostname: "localhost",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
      origin: "http://localhost",
    },
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
    }),
    getComputedStyle: () => new Proxy({}, { get: () => "" }),
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: noop,
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { userAgent: "stub" },
  };
  g.document = {
    createElement: fakeEl,
    createElementNS: fakeEl,
    createTextNode: () => ({}),
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: { style: {}, classList: { add: noop, remove: noop } },
    body: { style: {}, appendChild: noop },
    head: { appendChild: noop },
  };
  for (const n of [
    "MutationObserver",
    "ResizeObserver",
    "IntersectionObserver",
  ])
    g[n] = class {
      observe = noop;
      disconnect = noop;
      unobserve = noop;
      takeRecords = (): unknown[] => [];
    };
}

async function child(): Promise<void> {
  const keepPath = join(STATE, "keep.json");
  const keepSet = new Set<string>(
    existsSync(keepPath)
      ? (JSON.parse(readFileSync(keepPath, "utf8")) as string[])
      : [],
  );
  const loaded: string[] = [];
  const emitted: Record<string, string> = {};
  let cache: Record<string, string> | null = null;
  if (MODE === "timed")
    cache = JSON.parse(
      readFileSync(join(STATE, "cache.json"), "utf8"),
    ) as Record<string, string>;
  if (MODE === "baseline-plugin") cache = {};
  const stubbing = MODE === "discover" || MODE === "strict" || MODE === "timed";
  if (stubbing) installStubs(MODE !== "discover");
  if (HOST === "web") fakeDom();
  if (MODE !== "baseline") {
    Bun.plugin({
      name: "definition-closure",
      setup(build) {
        build.onLoad({ filter: CSS_RE }, () => ({
          contents: "",
          loader: "js",
        }));
        build.onLoad({ filter: MEDIA_RE }, () => ({
          contents: MEDIA_STUB,
          loader: "js",
        }));
        build.onLoad({ filter: REPO_SOURCE_RE }, (a) => {
          const loader = a.path.endsWith("x") ? "tsx" : "ts";
          const cached = MODE === "timed" ? cache?.[a.path] : undefined;
          if (cached !== undefined) return { contents: cached, loader };
          const code = readFileSync(a.path, "utf8");
          if (
            MODE === "timed" ||
            MODE === "baseline-plugin" ||
            a.path.includes("/node_modules/")
          )
            return { contents: code, loader };
          loaded.push(a.path);
          const out = transform(a.path, code, (k) => keepSet.has(k), false);
          emitted[a.path] = out;
          return { contents: out, loader };
        });
      },
    });
  }
  const failures: string[] = [];
  // Dynamic, by path: nothing of the repo may load before the plugin above.
  const ns = (await import(
    `${REPO}/plugins/infra/plugins/namespace/core/index.ts`
  )) as { asNamespace: (name: string) => unknown };
  const rid = (await import(
    `${REPO}/plugins/infra/plugins/runtime-identity/core/index.ts`
  )) as { declareRuntimeNamespace: (namespace: unknown) => void };
  rid.declareRuntimeNamespace(ns.asNamespace("equin"));
  interface Entry {
    pluginPath: string;
    id: string;
    loader: () => Promise<unknown>;
  }
  let entries: Entry[];
  if (HOST === "server") {
    const s = (await import(
      `${REPO}/plugins/framework/plugins/server-core/core/server.generated.ts`
    )) as { serverEntries: Entry[] };
    const m = (await import(
      `${REPO}/plugins/framework/plugins/server-core/core/machine.generated.ts`
    )) as { machineEntries: Entry[] };
    entries = [...s.serverEntries, ...m.machineEntries];
  } else {
    const w = (await import(
      `${REPO}/plugins/framework/plugins/web-sdk/core/web.generated.ts`
    )) as { webEntries: Entry[] };
    entries = w.webEntries;
  }
  const only = arg("--only", "");
  if (only) entries = entries.filter((e) => e.pluginPath.includes(only));
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let ok = 0;
  for (const e of entries) {
    try {
      const mod = (await e.loader()) as { default?: unknown };
      void mod.default;
      ok++;
    } catch (err) {
      failures.push(
        `${e.id}: ${String((err as Error)?.message ?? err).slice(0, 300)}`,
      );
    }
  }
  const cpu = process.cpuUsage(cpu0);
  const wallMs = performance.now() - t0;
  let classified = 0;
  if (MODE === "discover") classified = classify();
  const pool = MODE === "discover" ? mainTouched : touched;
  if (MODE === "discover" || MODE === "strict") propagate(keepSet, pool);
  const newKeys = [...pool].filter((k) => !keepSet.has(k));
  if (MODE === "discover" || MODE === "strict") {
    for (const k of newKeys) keepSet.add(k);
    writeFileSync(keepPath, JSON.stringify([...keepSet]));
  }
  if (MODE === "strict") {
    writeFileSync(join(STATE, "cache.json"), JSON.stringify(emitted));
    writeFileSync(join(STATE, "loaded.json"), JSON.stringify(loaded));
  }
  const cacheKeys = Object.keys(require.cache);
  const report = {
    mode: MODE,
    entries: entries.length,
    ok,
    failures: failures.length,
    failureSample: failures.slice(0, 8),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    wallMs: Math.round(wallMs),
    newKeys: newKeys.length,
    classified,
    unclassified: unclassified.length,
    keep: keepSet.size,
    repoModules:
      MODE === "baseline" || MODE === "baseline-plugin" || MODE === "timed"
        ? cacheKeys.filter((k) => !k.includes("/node_modules/")).length
        : loaded.length,
    npmModules: cacheKeys.filter((k) => k.includes("/node_modules/")).length,
    allModules: cacheKeys.length,
    stubs: allStubs.length,
  };
  if (arg("--dump-modules", ""))
    writeFileSync(arg("--dump-modules"), JSON.stringify(cacheKeys));
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  process.exit(0);
}

// ── parent ──────────────────────────────────────────────────────────────────

function run(mode: string, extra: string[] = []): Record<string, unknown> {
  const r = spawnSync(
    process.execPath,
    [
      import.meta.path,
      "--child",
      mode,
      "--host",
      HOST,
      "--policy",
      POLICY,
      "--state",
      STATE,
      ...extra,
    ],
    {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      cwd: REPO,
      env: process.env,
    },
  );
  const last = r.stdout.trimEnd().split("\n").at(-1) ?? "";
  if (r.status !== 0 || !last.startsWith("{")) {
    throw new Error(
      `child ${mode} failed (${String(r.status)}):\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-6000)}`,
    );
  }
  return JSON.parse(last) as Record<string, unknown>;
}

interface BundleSize {
  modules: number;
  rawKB: number;
  brKB: number;
}

/** The kept web closure as one minified file (`keep` null: today's code). */
async function bundleWeb(
  keep: Set<string> | null,
  external: boolean,
): Promise<BundleSize> {
  const w = (await import(
    `${REPO}/plugins/framework/plugins/web-sdk/core/web.generated.ts`
  )) as { webEntries: { pluginPath: string }[] };
  const paths = w.webEntries.map(
    (e) => `${REPO}/plugins/${e.pluginPath}/web/index.ts`,
  );
  mkdirSync(STATE, { recursive: true });
  const entry = join(STATE, "bundle-entry.ts");
  writeFileSync(
    entry,
    `${paths.map((p, i) => `import d${i} from ${q(p)};`).join("\n")}\nexport default [${paths.map((_, i) => `d${i}`).join(",")}];\n`,
  );
  let modules = 0;
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
    packages: external ? "external" : "bundle",
    external: [
      "@browser-host/*",
      "@browser-host-worker/*",
      "@browser-host-snapshot/*",
    ],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: "const __lz=(k)=>({k}),__lzo=(o)=>o;",
    throw: false,
    plugins: [
      {
        name: "definition-closure",
        setup(b) {
          b.onResolve(
            { filter: /\?(inline|raw|url|worker|sharedworker)$/ },
            (a) => ({ path: a.path, namespace: "query-stub" }),
          );
          b.onLoad({ filter: /.*/, namespace: "query-stub" }, () => ({
            contents: `export default "";`,
            loader: "js",
          }));
          b.onLoad({ filter: CSS_RE }, () => ({ contents: "", loader: "js" }));
          b.onLoad({ filter: MEDIA_RE }, () => ({
            contents: MEDIA_STUB,
            loader: "js",
          }));
          b.onLoad({ filter: REPO_SOURCE_RE }, (a) => {
            const code = readFileSync(a.path, "utf8");
            const loader = a.path.endsWith("x") ? "tsx" : "ts";
            if (a.path.includes("/node_modules/"))
              return { contents: code, loader };
            modules++;
            if (keep === null) return { contents: code, loader };
            return {
              contents: transform(a.path, code, (k) => keep.has(k), true),
              loader,
            };
          });
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error(
      `bundle failed:\n${result.logs.slice(0, 10).map(String).join("\n")}`,
    );
  }
  const text = await result.outputs[0]!.text();
  const br = brotliCompressSync(Buffer.from(text), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
  });
  return {
    modules,
    rawKB: Math.round(text.length / 1024),
    brKB: Math.round(br.length / 1024),
  };
}

async function parent(): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  const step = arg("--step", "all");
  const runs = Number(arg("--runs", "5"));
  const passthru = process.argv.includes("--only")
    ? ["--only", arg("--only")]
    : [];
  const until = (mode: string): void => {
    for (let i = 0; i < 60; i++) {
      const r = run(mode, passthru);
      console.log(JSON.stringify(r));
      if (r.newKeys === 0) return;
    }
    throw new Error(`${mode}: not stable after 60 rounds`);
  };
  const repeat = (mode: string): void => {
    for (let i = 0; i < runs; i++)
      console.log(JSON.stringify(run(mode, passthru)));
  };
  const bundle = async (): Promise<void> => {
    const keep = new Set(
      JSON.parse(readFileSync(join(STATE, "keep.json"), "utf8")) as string[],
    );
    console.log(
      JSON.stringify({
        bundle: `policy ${POLICY}`,
        ownCode: await bundleWeb(keep, true),
        withPackages: await bundleWeb(keep, false),
      }),
    );
    console.log(
      JSON.stringify({
        bundle: "today",
        ownCode: await bundleWeb(null, true),
        withPackages: await bundleWeb(null, false),
      }),
    );
  };
  if (step === "all") {
    until("discover");
    until("strict");
    repeat("timed");
    repeat("baseline");
    if (HOST === "web") await bundle();
  } else if (step === "discover" || step === "strict") {
    until(step);
  } else if (step === "bundle") {
    await bundle();
  } else {
    repeat(step);
  }
}

if (MODE) await child();
else await parent();
