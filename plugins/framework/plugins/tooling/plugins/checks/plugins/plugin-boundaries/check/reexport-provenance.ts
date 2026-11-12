// ============================================================================
// Name-level cross-plugin re-export provenance resolver.
//
// The `cross-plugin-reexport` rule forbids a plugin's barrel from surfacing
// another plugin's symbols. A barrel can do this in three equivalent ways:
//   1. directly:   export { X } from "@plugins/other/core"
//   2. indirectly: export { X } from "./types"  (./types re-exports from other)
//   3. import-then-reexport: import { X } from "@plugins/other/core"; export { X }
//
// This resolver follows every NAME a barrel surfaces back to its true origin
// plugin (at any depth, through internal files), and flags any whose origin is
// not the barrel's own plugin. Resolution is name-level, not file-level: an
// internal file may re-export foreign symbols the barrel never surfaces — those
// must NOT be flagged.
//
// It reads no file: each file's re-export statements are summarized on their
// own (`summarizeExports`, run per file by the check's fold), and the resolver
// follows names through those summaries — so a pass after an edit re-reads
// only the edited files, and the unit test needs no repo.
// ============================================================================

import {
  splitTopLevelStatements,
  extractFromSpecifier,
  parseBindingList,
} from "./parse";

export interface Violation {
  rule: string;
  file: string;
  message: string;
  fix?: string;
}

export interface CollectForeignReexportsOptions {
  /** Barrel path relative to repo root, e.g. "plugins/tasks/core/index.ts". */
  barrelRel: string;
  /** Owning plugin relpath, e.g. "tasks" or "conversations/plugins/conversation-view". */
  ownPlugin: string;
  /** Known plugin relpaths (for longest-prefix resolution of @plugins specifiers). */
  pluginSet: ReadonlySet<string>;
  /** A repo-relative file's re-export summary; undefined when it re-exports nothing (or does not exist). */
  exportsOf: (relPath: string) => FileExports | undefined;
  /** Whether a repo-relative path is a file of the set. */
  exists: (relPath: string) => boolean;
}

/**
 * What one file re-exports — all a provenance chase reads of it — as compact
 * plain JSON, so it can be kept as a fold's part (rewritten whole along the
 * edited path, so spelled as tuples, not objects):
 *
 * - `from`: `export { local as exported } from "spec"` → `[exported, local, spec, line]`
 * - `bare`: `export { local as exported }` → `[exported, local, spec, line]`,
 *   `spec` the specifier `local` was imported from, or null when it is declared
 *   in the file
 * - `wildcard`: `export * from "spec"` → `[spec, line]`
 */
export interface FileExports {
  from: [exported: string, local: string, spec: string, line: number][];
  bare: [exported: string, local: string, spec: string | null, line: number][];
  wildcard: [spec: string, line: number][];
}

/** `src`'s re-export summary, or null when it re-exports nothing. */
export function summarizeExports(src: string): FileExports | null {
  const parsed = parseFile(src);
  if (
    parsed.fromReexports.length === 0 &&
    parsed.bareReexports.length === 0 &&
    parsed.wildcardFrom.length === 0
  )
    return null;
  return {
    from: parsed.fromReexports.map((r) => [
      r.exported,
      r.local,
      r.spec,
      r.line,
    ]),
    bare: parsed.bareReexports.map((r) => [
      r.exported,
      r.local,
      parsed.imports.get(r.local)?.spec ?? null,
      r.line,
    ]),
    wildcard: parsed.wildcardFrom.map((w) => [w.spec, w.line]),
  };
}

/** A summary in the shape the chase reads. */
interface Exports {
  fromReexports: {
    exported: string;
    local: string;
    spec: string;
    line: number;
  }[];
  bareReexports: {
    exported: string;
    local: string;
    spec: string | null;
    line: number;
  }[];
  wildcardFrom: { spec: string; line: number }[];
}

const expandedOf = new WeakMap<FileExports, Exports>();
function expand(summary: FileExports | undefined): Exports | undefined {
  if (summary === undefined) return undefined;
  let e = expandedOf.get(summary);
  if (!e) {
    e = {
      fromReexports: summary.from.map(([exported, local, spec, line]) => ({
        exported,
        local,
        spec,
        line,
      })),
      bareReexports: summary.bare.map(([exported, local, spec, line]) => ({
        exported,
        local,
        spec,
        line,
      })),
      wildcardFrom: summary.wildcard.map(([spec, line]) => ({ spec, line })),
    };
    expandedOf.set(summary, e);
  }
  return e;
}

// ----------------------------------------------------------------------------
// Per-file parse result
// ----------------------------------------------------------------------------

interface FromReexport {
  exported: string;
  local: string;
  spec: string;
  typeOnly: boolean;
  line: number;
}

interface BareReexport {
  exported: string;
  local: string;
  typeOnly: boolean;
  line: number;
}

interface ImportBinding {
  spec: string;
  typeOnly: boolean;
}

interface ParsedFile {
  /** in-file local name → its import source */
  imports: Map<string, ImportBinding>;
  fromReexports: FromReexport[];
  bareReexports: BareReexport[];
  /** relative/@plugins/external specifiers of `export * from "spec"` */
  wildcardFrom: { spec: string; line: number }[];
  localExports: Set<string>;
}

function isImportStmt(s: string): boolean {
  return /^import\b/.test(s) || s.startsWith("import{");
}

function isExportStmt(s: string): boolean {
  return /^export\b/.test(s);
}

function parseFile(src: string): ParsedFile {
  const stmts = splitTopLevelStatements(src);
  const imports = new Map<string, ImportBinding>();
  const fromReexports: FromReexport[] = [];
  const bareReexports: BareReexport[] = [];
  const wildcardFrom: { spec: string; line: number }[] = [];
  const localExports = new Set<string>();

  for (const { text, line } of stmts) {
    const trimmed = text.trim();
    if (!trimmed) continue;

    if (isImportStmt(trimmed)) {
      const spec = extractFromSpecifier(trimmed);
      if (!spec) continue; // bare side-effect import — no bindings
      const body = importExportBody(trimmed, "import");
      // `import * as N from "spec"` — namespace binding.
      const nsMatch = body.match(/^(?:type\s+)?\*\s+as\s+(\w+)$/);
      if (nsMatch) {
        const typeOnly = /^type\s+/.test(body);
        imports.set(nsMatch[1]!, { spec, typeOnly });
        continue;
      }
      // Default binding (`import Foo from`, `import Foo, { … } from`).
      const bodyTypeOnly = /^type\s+/.test(body);
      const defaultMatch = body
        .replace(/^type\s+/, "")
        .match(/^(\w+)\s*(?:,|$)/);
      if (defaultMatch && !body.replace(/^type\s+/, "").startsWith("{")) {
        imports.set(defaultMatch[1]!, { spec, typeOnly: bodyTypeOnly });
      }
      // Named bindings.
      for (const b of parseBindingList(trimmed)) {
        // For imports, `exported` is the in-file local name.
        imports.set(b.exported, { spec, typeOnly: bodyTypeOnly || b.typeOnly });
      }
      continue;
    }

    if (isExportStmt(trimmed)) {
      const spec = extractFromSpecifier(trimmed);
      const body = importExportBody(trimmed, "export");

      // Wildcard re-export: `export * from "spec"` / `export * as N from "spec"`.
      if (/^(?:type\s+)?\*/.test(body)) {
        if (spec) wildcardFrom.push({ spec, line });
        continue;
      }

      // Named re-export / bare re-export: `export { … } [from "spec"]`.
      if (body.startsWith("{") || /^type\s*\{/.test(body)) {
        const stmtTypeOnly = /^type\s+/.test(body);
        const bindings = parseBindingList(trimmed);
        if (spec) {
          for (const b of bindings) {
            fromReexports.push({
              exported: b.exported,
              local: b.local,
              spec,
              typeOnly: stmtTypeOnly || b.typeOnly,
              line,
            });
          }
        } else {
          for (const b of bindings) {
            bareReexports.push({
              exported: b.exported,
              local: b.local,
              typeOnly: stmtTypeOnly || b.typeOnly,
              line,
            });
          }
        }
        continue;
      }

      // Declaration export: `export const/function/class/type/interface X`,
      // `export default …`, `export async function X`, etc. These OWN a name
      // (or default) in this file.
      collectDeclaredExports(trimmed, localExports);
      continue;
    }
  }

  return { imports, fromReexports, bareReexports, wildcardFrom, localExports };
}

/** Extract the body between the keyword and a trailing `from "spec"` (if any). */
function importExportBody(stmt: string, keyword: "import" | "export"): string {
  let rest = stmt.slice(keyword.length).trim();
  const fromIdx = lastTopLevelFrom(rest);
  if (fromIdx !== -1) rest = rest.slice(0, fromIdx).trim();
  return rest;
}

/** Index of the ` from ` that introduces the module specifier, or -1. */
function lastTopLevelFrom(rest: string): number {
  const m = rest.match(/\sfrom\s+["'][^"']+["']\s*$/);
  if (!m) return -1;
  return m.index!;
}

function collectDeclaredExports(stmt: string, localExports: Set<string>) {
  const body = stmt.slice("export".length).trim();
  if (body.startsWith("default")) {
    localExports.add("default");
    return;
  }
  // export [async] [const|let|var|function|class|type|interface|enum|namespace] Name
  const m = body.match(
    /^(?:async\s+)?(?:const|let|var|function\*?|class|abstract\s+class|type|interface|enum|namespace|declare)\s+([A-Za-z_$][\w$]*)/,
  );
  if (m) localExports.add(m[1]!);
}

// ----------------------------------------------------------------------------
// @plugins specifier → origin plugin
// ----------------------------------------------------------------------------

/**
 * Resolve an `@plugins/<p>/<runtime>[/tail]` specifier to its owning plugin
 * relpath via longest-prefix match, mirroring index.ts's `resolveImport`.
 * Returns the plugin relpath only when the specifier targets a barrel
 * (suffixHead is a runtime, tail empty) — that's the only legal cross-plugin
 * form and the only one this rule resolves origins from.
 */
function pluginFromSpec(
  spec: string,
  pluginSet: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith("@plugins/")) return null;
  const rest = spec.slice("@plugins/".length);
  const parts = rest.split("/");
  let best = "";
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  if (!best) return null;
  return best;
}

// ----------------------------------------------------------------------------
// Relative specifier → resolved file relpath (within ownPlugin)
// ----------------------------------------------------------------------------

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function normalizeJoin(base: string, rel: string): string {
  const segs = base ? base.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

/**
 * Resolve a relative specifier from `fromFileRel` to a concrete file relpath,
 * trying `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. Returns null if none exists.
 */
function resolveRelativeFile(
  fromFileRel: string,
  spec: string,
  exists: (relPath: string) => boolean,
): string | null {
  const base = normalizeJoin(dirOf(fromFileRel), spec);
  const candidates = [
    base + ".ts",
    base + ".tsx",
    base + "/index.ts",
    base + "/index.tsx",
  ];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Owning plugin relpath for a repo-root-relative file path, or null. */
function pluginForFile(
  fileRel: string,
  pluginSet: ReadonlySet<string>,
): string | null {
  const norm = fileRel.split("\\").join("/");
  if (!norm.startsWith("plugins/")) return null;
  const rest = norm.slice("plugins/".length);
  const parts = rest.split("/");
  let best: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  return best;
}

// ----------------------------------------------------------------------------
// Origin resolution
// ----------------------------------------------------------------------------

type Origin = { plugin: string } | "LOCAL" | "EXTERNAL";

interface ResolveContext {
  ownPlugin: string;
  pluginSet: ReadonlySet<string>;
  exportsOf: (relPath: string) => FileExports | undefined;
  exists: (relPath: string) => boolean;
}

/**
 * Follow `exportedName` (a name surfaced/re-exported by `fileRel`) to its origin.
 * Returns `{ plugin }` when the name originates in another plugin via a barrel
 * specifier, "EXTERNAL" for node_modules / R8-owned relative escapes, "LOCAL"
 * otherwise.
 */
function resolveOrigin(
  ctx: ResolveContext,
  fileRel: string,
  exportedName: string,
  visited: Set<string>,
): Origin {
  const key = `${fileRel}|${exportedName}`;
  if (visited.has(key)) return "LOCAL"; // cycle: bottom out as local
  visited.add(key);

  const parsed = expand(ctx.exportsOf(fileRel));
  if (!parsed) return "LOCAL";

  // 1. from-reexport: `export { exported as ? } from "spec"`.
  const fromRx = parsed.fromReexports.find((r) => r.exported === exportedName);
  if (fromRx) {
    return originFromSpec(ctx, fileRel, fromRx.spec, fromRx.local, visited);
  }

  // 2. bare re-export: `export { local as exported }` (no from) → trace `local`.
  const bareRx = parsed.bareReexports.find((r) => r.exported === exportedName);
  if (bareRx) {
    if (bareRx.spec !== null)
      return originFromSpec(ctx, fileRel, bareRx.spec, bareRx.local, visited);
    // Not imported — it's a locally declared name surfaced by name.
    return "LOCAL";
  }

  // 3. wildcard re-export: name could come from any `export * from "spec"`.
  for (const w of parsed.wildcardFrom) {
    const o = originFromSpec(ctx, fileRel, w.spec, exportedName, visited);
    if (o !== "LOCAL") return o;
  }

  // 4. otherwise local.
  return "LOCAL";
}

/**
 * Resolve the origin of `nameInSource` reached through `spec` from `fromFileRel`.
 * `spec` may be an `@plugins/...` barrel, a relative path, or an external module.
 */
function originFromSpec(
  ctx: ResolveContext,
  fromFileRel: string,
  spec: string,
  nameInSource: string,
  visited: Set<string>,
): Origin {
  if (spec.startsWith("@plugins/")) {
    const plugin = pluginFromSpec(spec, ctx.pluginSet);
    if (plugin) return { plugin };
    // Unresolvable @plugins specifier — treat as external (not our concern).
    return "EXTERNAL";
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = resolveRelativeFile(fromFileRel, spec, ctx.exists);
    if (!target) return "EXTERNAL"; // can't follow; not our concern
    // If the relative path escapes the owning plugin, R8 owns that — stop.
    const targetPlugin = pluginForFile(target, ctx.pluginSet);
    if (targetPlugin !== ctx.ownPlugin) return "EXTERNAL";
    return resolveOrigin(ctx, target, nameInSource, visited);
  }
  return "EXTERNAL";
}

// ----------------------------------------------------------------------------
// Public entry
// ----------------------------------------------------------------------------

export function collectForeignReexports(
  opts: CollectForeignReexportsOptions,
): Violation[] {
  const { barrelRel, ownPlugin, pluginSet, exportsOf, exists } = opts;
  const ctx: ResolveContext = { ownPlugin, pluginSet, exportsOf, exists };

  const barrel = expand(exportsOf(barrelRel));
  if (!barrel) return [];

  const violations: Violation[] = [];
  const seen = new Set<string>(); // dedupe per (exported, ultimate plugin)

  // Each name the barrel surfaces (from-reexport, bare re-export, wildcard).
  interface Surfaced {
    exported: string;
    line: number;
    /** ultimate specifier hint for the message (best-effort). */
    immediateSpec: string;
  }
  const surfaced: Surfaced[] = [];
  for (const r of barrel.fromReexports) {
    surfaced.push({
      exported: r.exported,
      line: r.line,
      immediateSpec: r.spec ?? "(local)",
    });
  }
  for (const r of barrel.bareReexports) {
    surfaced.push({
      exported: r.exported,
      line: r.line,
      immediateSpec: r.spec ?? "(local)",
    });
  }
  // Wildcard re-exports surface an unknown set of names. We can only resolve the
  // foreign-cross-plugin case conservatively (the spec itself is the origin).
  for (const w of barrel.wildcardFrom) {
    const plugin = pluginFromSpec(w.spec, pluginSet);
    if (plugin && plugin !== ownPlugin) {
      const dedupe = `*|${plugin}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      violations.push({
        rule: "cross-plugin-reexport",
        file: `${barrelRel}:${w.line}`,
        message: `barrel wildcard re-exports from another plugin (\`${plugin}\`): \`${w.spec}\``,
        fix: `import the source barrel directly — never proxy another plugin's symbols through your own barrel. Consumers should \`import { … } from "${w.spec}"\` themselves.`,
      });
    }
    // relative wildcard within ownPlugin: names are unknown, can't enumerate; skip.
  }

  for (const s of surfaced) {
    const origin = resolveOrigin(ctx, barrelRel, s.exported, new Set());
    if (origin === "LOCAL" || origin === "EXTERNAL") continue;
    if (origin.plugin === ownPlugin) continue;

    const ultimateSpec =
      walkSpec(ctx, barrelRel, s.exported, new Set()) ?? origin.plugin;
    const dedupe = `${s.exported}|${origin.plugin}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const indirect =
      s.immediateSpec !== ultimateSpec &&
      !s.immediateSpec.startsWith("@plugins/");
    const chainNote = indirect ? ` (via \`${s.immediateSpec}\`)` : "";
    violations.push({
      rule: "cross-plugin-reexport",
      file: `${barrelRel}:${s.line}`,
      message: `barrel surfaces \`${s.exported}\` which originates in another plugin (\`${origin.plugin}\`)${chainNote} — ultimate source \`${ultimateSpec}\``,
      fix: `import the source barrel directly — never proxy another plugin's symbols through your own barrel. Consumers should \`import { ${s.exported} } from "${ultimateSpec}"\` themselves.`,
    });
  }

  return violations;
}

/**
 * Best-effort reconstruction of the ultimate `@plugins/...` specifier a surfaced
 * name resolves to, for the message + exception key. Walks the same chain as
 * resolveOrigin but returns the foreign specifier string.
 */
function walkSpec(
  ctx: ResolveContext,
  fileRel: string,
  exportedName: string,
  visited: Set<string>,
): string | null {
  const key = `${fileRel}|${exportedName}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const parsed = expand(ctx.exportsOf(fileRel));
  if (!parsed) return null;

  const fromRx = parsed.fromReexports.find((r) => r.exported === exportedName);
  if (fromRx) return specWalk(ctx, fileRel, fromRx.spec, fromRx.local, visited);

  const bareRx = parsed.bareReexports.find((r) => r.exported === exportedName);
  if (bareRx) {
    if (bareRx.spec !== null)
      return specWalk(ctx, fileRel, bareRx.spec, bareRx.local, visited);
    return null;
  }
  for (const w of parsed.wildcardFrom) {
    const r = specWalk(ctx, fileRel, w.spec, exportedName, visited);
    if (r) return r;
  }
  return null;
}

function specWalk(
  ctx: ResolveContext,
  fromFileRel: string,
  spec: string,
  nameInSource: string,
  visited: Set<string>,
): string | null {
  if (spec.startsWith("@plugins/")) return spec;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = resolveRelativeFile(fromFileRel, spec, ctx.exists);
    if (!target) return null;
    if (pluginForFile(target, ctx.pluginSet) !== ctx.ownPlugin) return null;
    return walkSpec(ctx, target, nameInSource, visited);
  }
  return null;
}
