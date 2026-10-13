import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import {
  listCandidateSources,
  type CandidateSource,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  findImports,
  lineAt,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  inputKeyed?: boolean;
  run(): Promise<CheckResult>;
};

// A contributed-column handle (`liveColumns`, in a contributor's core) is only
// the declaration: its values reach the wire when the contributor's server
// serves it (`serveColumns(handle, …)` in a `LiveColumns.Serve` contribution).
// A handle nothing serves type-checks, bundles and renders — and fails every
// query that names its columns with a decode error, at the first use. This
// check makes that a build error instead: every handle has a
// `serveColumns(<handle>` in its own plugin's `server/`.
//
// Both halves are read off whole files with comments and strings masked, so a
// declaration or a call wrapped over lines still reads, and a served handle is
// resolved through the serving file's import bindings (`import { x as y }` →
// `serveColumns(y` serves `x`). Test code neither declares nor serves.

/** A `liveColumns(` call — not the function's own definition. */
const CALL = /(?<!\bfunction\s+)\bliveColumns\s*(?:<[^()]*>)?\s*\(/g;
/** The binding a call is the initializer of: `const x =` / `const x: T =` right before it. */
const BOUND = /\bconst\s+(\w+)\s*(?::[^=;]*)?=\s*$/;
/** A `serveColumns(<identifier>` call: the handle it serves. */
const SERVE = /\bserveColumns\s*(?:<[^()]*>)?\s*\(\s*(\w+)/g;

/** Test code neither declares a handle nor serves one. */
const notTest = (f: CandidateSource) => !isTestCodePath(f.rel.split("/"));

/** The plugin root of a repo-relative path: everything before its first runtime folder. */
function pluginRootOf(path: string): string | null {
  const at = path.search(/\/(core|web|shared|server)\//);
  return at === -1 ? null : path.slice(0, at);
}

/** Every handle a declaring file mints, or the call no `const` binds (named by line). */
function declaredIn(
  file: CandidateSource,
): { name: string | null; line: number }[] {
  const masked = maskSource(file.src);
  const out: { name: string | null; line: number }[] = [];
  for (const m of masked.matchAll(CALL)) {
    // The binding sits right before the call; a bounded look-back keeps the
    // end-anchored match linear in the file.
    const before = masked.slice(Math.max(0, m.index - 400), m.index);
    const name = BOUND.exec(before)?.[1] ?? null;
    out.push({ name, line: lineAt(file.src, m.index) });
  }
  return out;
}

/** Local binding → the name it was imported under, from every `import { a as b }` of a file. */
function importAliases(file: CandidateSource): Map<string, string> {
  const imported = new Map<string, string>();
  for (const imp of findImports(file.src)) {
    const braces = /\{([^}]*)\}/.exec(imp.clause)?.[1];
    if (braces === undefined) continue;
    for (const spec of braces.split(",")) {
      const m = /^\s*(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(spec);
      if (m) imported.set(m[2] ?? m[1]!, m[1]!);
    }
  }
  return imported;
}

/** The handles a serving file serves, by the name they are EXPORTED under (import aliases undone). */
function servedIn(file: CandidateSource): Set<string> {
  const masked = maskSource(file.src);
  const imported = importAliases(file);
  const out = new Set<string>();
  for (const m of masked.matchAll(SERVE)) {
    const local = m[1]!;
    out.add(imported.get(local) ?? local);
  }
  return out;
}

/**
 * The declared handles (outside test code) no `serveColumns(<handle>` in the same plugin's
 * `server/` serves outside test code — and every `liveColumns(` call no `const` binds (the check
 * cannot tell which handle it is) — as `path:line — name`.
 */
export function unservedHandles(
  declaring: readonly CandidateSource[],
  serving: readonly CandidateSource[],
): string[] {
  const servedByPlugin = new Map<string, Set<string>>();
  for (const file of serving.filter(notTest)) {
    const root = pluginRootOf(file.rel);
    if (root === null || !file.rel.startsWith(`${root}/server/`)) continue;
    const set = servedByPlugin.get(root) ?? new Set<string>();
    for (const name of servedIn(file)) set.add(name);
    servedByPlugin.set(root, set);
  }
  const missing: string[] = [];
  for (const file of declaring.filter(notTest)) {
    const root = pluginRootOf(file.rel);
    for (const { name, line } of declaredIn(file)) {
      if (name === null) {
        missing.push(
          `${file.rel}:${line} — a liveColumns(…) call no \`const\` binds`,
        );
        continue;
      }
      if (root !== null && servedByPlugin.get(root)?.has(name)) continue;
      missing.push(`${file.rel}:${line} — ${name}`);
    }
  }
  return missing;
}

const contributedColumnsServed: Check = {
  id: "live:contributed-columns-served",
  // INPUT-KEYED: a pure scan of tracked sources.
  inputKeyed: true,
  description:
    "Every contributed-column handle (`const x = liveColumns(…)`, network/live) is served by its own plugin's server: a `serveColumns(x` (through any import alias) in that plugin's `server/`, outside test code. An unserved handle's columns reach no row, and every query naming them fails to decode.",
  async run() {
    const root = await getWorktreeRoot();
    const declaring = await listCandidateSources({
      root,
      grepArg: "liveColumns",
      fixed: true,
    });
    const serving = await listCandidateSources({
      root,
      grepArg: "serveColumns",
      fixed: true,
    });
    const missing = unservedHandles(declaring, serving);
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} contributed-column handle(s) are served by no server:\n    ${missing.join("\n    ")}`,
      hint: "Bind each handle to a `const` in the contributor's core, and in that plugin's server barrel contribute `LiveColumns.Serve(serveColumns(handle, { join: ext.join(\"<alias>\") }))` (network/live/server).",
    };
  },
};

// ── live:exposures-registered ──────────────────────────────────────────────
// An extension shape declaring `exposes` (entity-extensions) is only the
// declaration: its fields reach a list when its plugin's server folds the
// extension (`LiveColumns.Expose(<the defineExtension handle over it>)`) and
// its web registers the exposure (`LiveExposures.Register({ exposure:
// <shape>.exposure, … })`). Either half missing type-checks and renders — the
// fields are silently absent from every list (no web half), or every list
// throws reading a slice the server never folded (no server half). Read like
// the check above: masked whole files, import aliases undone, no test code.

/** A `defineExtensionShape(` call — not the function's own definition. */
const SHAPE_CALL =
  /(?<!\bfunction\s+)\bdefineExtensionShape\s*(?:<[^()]*>)?\s*\(/g;
/** A `defineExtension(` call — not the function's own definition. */
const EXTENSION_CALL =
  /(?<!\bfunction\s+)\bdefineExtension\s*(?:<[^()]*>)?\s*\(/g;
/** A `LiveColumns.Expose(<identifier>` call: the extension handle it folds. */
const EXPOSE = /\bLiveColumns\s*\.\s*Expose\s*\(\s*(\w+)/g;
/** A `LiveExposures.Register(` call. */
const REGISTER = /\bLiveExposures\s*\.\s*Register\s*\(/g;

/** The text of a call's arguments: from just after its `(` to the matching `)`. */
function callArgs(masked: string, afterOpen: number): string {
  let depth = 1;
  for (let i = afterOpen; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return masked.slice(afterOpen, i);
  }
  return masked.slice(afterOpen);
}

/** The identifiers a span names, each by the name it was imported under. */
function namesIn(span: string, imported: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const m of span.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    out.add(imported.get(m[0]) ?? m[0]);
  }
  return out;
}

/** Every call of `call` in a file: its bound `const` (null when none binds it), line and argument text. */
function boundCalls(
  file: CandidateSource,
  call: RegExp,
): { name: string | null; line: number; args: string }[] {
  const masked = maskSource(file.src);
  const out: { name: string | null; line: number; args: string }[] = [];
  for (const m of masked.matchAll(call)) {
    const before = masked.slice(Math.max(0, m.index - 400), m.index);
    out.push({
      name: BOUND.exec(before)?.[1] ?? null,
      line: lineAt(file.src, m.index),
      args: callArgs(masked, m.index + m[0].length),
    });
  }
  return out;
}

/** The plugin root of a file in `runtime/` of its plugin, else null. */
function rootIn(file: CandidateSource, runtime: string): string | null {
  const root = pluginRootOf(file.rel);
  return root !== null && file.rel.startsWith(`${root}/${runtime}/`)
    ? root
    : null;
}

/**
 * The exposing shapes (outside test code) whose own plugin does not both fold
 * them on its server — a `LiveColumns.Expose(h)` of a handle `h =
 * defineExtension(…, <shape>, …)` — and register them on its web — a
 * `LiveExposures.Register(…)` naming the shape — as `path:line — name (…)`.
 */
export function unregisteredExposures(
  declaring: readonly CandidateSource[],
  server: readonly CandidateSource[],
  web: readonly CandidateSource[],
): string[] {
  // Per plugin: each extension handle → the identifiers its call names, and
  // the handles its server folds.
  const handles = new Map<string, Map<string, Set<string>>>();
  const exposed = new Map<string, Set<string>>();
  for (const file of server.filter(notTest)) {
    const root = rootIn(file, "server");
    if (root === null) continue;
    const imported = importAliases(file);
    const own = handles.get(root) ?? new Map<string, Set<string>>();
    for (const { name, args } of boundCalls(file, EXTENSION_CALL)) {
      if (name !== null) own.set(name, namesIn(args, imported));
    }
    handles.set(root, own);
    const folded = exposed.get(root) ?? new Set<string>();
    for (const m of maskSource(file.src).matchAll(EXPOSE)) {
      folded.add(imported.get(m[1]!) ?? m[1]!);
    }
    exposed.set(root, folded);
  }
  // Per plugin: the identifiers its web's `LiveExposures.Register(` calls name.
  const registered = new Map<string, Set<string>>();
  for (const file of web.filter(notTest)) {
    const root = rootIn(file, "web");
    if (root === null) continue;
    const imported = importAliases(file);
    const masked = maskSource(file.src);
    const names = registered.get(root) ?? new Set<string>();
    for (const m of masked.matchAll(REGISTER)) {
      const args = callArgs(masked, m.index + m[0].length);
      for (const n of namesIn(args, imported)) names.add(n);
    }
    registered.set(root, names);
  }
  const missing: string[] = [];
  for (const file of declaring.filter(notTest)) {
    const root = pluginRootOf(file.rel) ?? "";
    for (const { name, line, args } of boundCalls(file, SHAPE_CALL)) {
      if (!/\bexposes\b/.test(args)) continue;
      if (name === null) {
        missing.push(
          `${file.rel}:${line} — an exposing defineExtensionShape(…) call no \`const\` binds`,
        );
        continue;
      }
      const lacks: string[] = [];
      const folded = [...(handles.get(root) ?? [])].some(
        ([handle, names]) =>
          names.has(name) && (exposed.get(root)?.has(handle) ?? false),
      );
      if (!folded) lacks.push("server: LiveColumns.Expose");
      if (!(registered.get(root)?.has(name) ?? false)) {
        lacks.push("web: LiveExposures.Register");
      }
      if (lacks.length > 0) {
        missing.push(`${file.rel}:${line} — ${name} (${lacks.join(", ")})`);
      }
    }
  }
  return missing;
}

const exposuresRegistered: Check = {
  id: "live:exposures-registered",
  // INPUT-KEYED: a pure scan of tracked sources.
  inputKeyed: true,
  description:
    "Every extension shape declaring `exposes` (entity-extensions) is folded by its own plugin's server — `LiveColumns.Expose(h)` of a `defineExtension` handle over it — and registered by its own plugin's web — `LiveExposures.Register({ exposure: shape.exposure })` — outside test code. A half missing leaves its fields absent from every list, or every list reading a slice the server never folded.",
  async run() {
    const root = await getWorktreeRoot();
    const declaring = await listCandidateSources({
      root,
      grepArg: "defineExtensionShape",
      fixed: true,
    });
    // `defineExtension` matches the shape files too; the server filter drops
    // whatever is not under a plugin's `server/`.
    const server = await listCandidateSources({
      root,
      grepArg: "defineExtension",
      fixed: true,
    });
    const serving = await listCandidateSources({
      root,
      grepArg: "LiveColumns.Expose",
      fixed: true,
    });
    const seen = new Set(server.map((f) => f.rel));
    const web = await listCandidateSources({
      root,
      grepArg: "LiveExposures.Register",
      fixed: true,
    });
    const missing = unregisteredExposures(
      declaring,
      [...server, ...serving.filter((f) => !seen.has(f.rel))],
      web,
    );
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} exposing extension shape(s) are not folded and registered by their own plugin:\n    ${missing.join("\n    ")}`,
      hint: "In the extension's plugin, contribute `LiveColumns.Expose(ext)` (network/live/server) from its server barrel, where `ext = defineExtension(parent, name, shape)`, and `LiveExposures.Register({ exposure: shape.exposure })` (network/live/web) from its web barrel.",
    };
  },
};

export default [contributedColumnsServed, exposuresRegistered];
