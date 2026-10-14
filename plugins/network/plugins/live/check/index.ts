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

// Shared by both checks below: declarations and registrations are read off
// whole files with comments and strings masked, so a call wrapped over lines
// still reads, and a name is resolved through the reading file's import
// bindings (`import { x as y }` → `y` names `x`). Test code neither declares
// nor registers.

/** The binding a call is the initializer of: `const x =` / `const x: T =` right before it. */
const BOUND = /\bconst\s+(\w+)\s*(?::[^=;]*)?=\s*$/;

/** Test code neither declares nor registers. */
const notTest = (f: CandidateSource) => !isTestCodePath(f.rel.split("/"));

/** The plugin root of a repo-relative path: everything before its first runtime folder. */
function pluginRootOf(path: string): string | null {
  const at = path.search(/\/(core|web|shared|server)\//);
  return at === -1 ? null : path.slice(0, at);
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

// ── live:exposures-registered ──────────────────────────────────────────────
// An extension shape declaring `exposes` (entity-extensions) is only the
// declaration: its fields reach a list when its plugin's server folds the
// extension (`LiveColumns.Expose(<the defineExtension handle over it>)`) and
// its web registers the exposure (`FieldPresentation.Register({ owner:
// <shape>.exposure, … })`). Either half missing type-checks and renders — the
// fields are silently absent from every list (no web half), or every list
// throws reading a slice the server never folded (no server half).

/** A `defineExtensionShape(` call — not the function's own definition. */
const SHAPE_CALL =
  /(?<!\bfunction\s+)\bdefineExtensionShape\s*(?:<[^()]*>)?\s*\(/g;
/** A `defineExtension(` call — not the function's own definition. */
const EXTENSION_CALL =
  /(?<!\bfunction\s+)\bdefineExtension\s*(?:<[^()]*>)?\s*\(/g;
/** A `LiveColumns.Expose(<identifier>` call: the extension handle it folds. */
const EXPOSE = /\bLiveColumns\s*\.\s*Expose\s*\(\s*(\w+)/g;
/** A `FieldPresentation.Register(` call. */
const REGISTER = /\bFieldPresentation\s*\.\s*Register\s*\(/g;

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

/** Per plugin: the identifiers its web's `FieldPresentation.Register(` calls name (import aliases undone). */
function registeredNames(
  web: readonly CandidateSource[],
): Map<string, Set<string>> {
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
  return registered;
}

/**
 * The exposing shapes (outside test code) whose own plugin does not both fold
 * them on its server — a `LiveColumns.Expose(h)` of a handle `h =
 * defineExtension(…, <shape>, …)` — and register them on its web — a
 * `FieldPresentation.Register(…)` naming the shape — as `path:line — name (…)`.
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
  const registered = registeredNames(web);
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
        lacks.push("web: FieldPresentation.Register");
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
    "Every extension shape declaring `exposes` (entity-extensions) is folded by its own plugin's server — `LiveColumns.Expose(h)` of a `defineExtension` handle over it — and registered by its own plugin's web — `FieldPresentation.Register({ owner: shape.exposure })` — outside test code. A half missing leaves its fields absent from every list, or every list reading a slice the server never folded.",
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
      grepArg: "FieldPresentation.Register",
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
      hint: "In the extension's plugin, contribute `LiveColumns.Expose(ext)` (network/live/server) from its server barrel, where `ext = defineExtension(parent, name, shape)`, and `FieldPresentation.Register({ owner: shape.exposure })` (network/live/web) from its web barrel.",
    };
  },
};

// ── live:arms-registered ───────────────────────────────────────────────────
// A union arm declared by fields (`const x = liveArm(…)`, in the arm's core)
// reaches a list when its plugin's server binds it (the union's arm binding —
// `runs`' `defineRunKind({ columns: x, … })` — names it in `server/`) and its
// web registers it (`FieldPresentation.Register({ owner: x, … })`). Either half
// missing type-checks: the arm's rows carry no slice (its `read` throws), or
// its fields are absent from every list of the union.

/** A `liveArm(` call — not the function's own definition. */
const ARM_CALL = /(?<!\bfunction\s+)\bliveArm\s*(?:<[^()]*>)?\s*\(/g;

/**
 * The arms (outside test code) whose own plugin's `server/` names no binding
 * of them, or whose `web/` registers no presentation of them — as `path:line
 * — name (…)`.
 */
export function unregisteredArms(
  declaring: readonly CandidateSource[],
  server: readonly CandidateSource[],
  web: readonly CandidateSource[],
): string[] {
  const bound = new Map<string, Set<string>>();
  for (const file of server.filter(notTest)) {
    const root = rootIn(file, "server");
    if (root === null) continue;
    const names = bound.get(root) ?? new Set<string>();
    for (const n of namesIn(maskSource(file.src), importAliases(file))) {
      names.add(n);
    }
    bound.set(root, names);
  }
  const registered = registeredNames(web);
  const missing: string[] = [];
  for (const file of declaring.filter(notTest)) {
    const root = pluginRootOf(file.rel) ?? "";
    for (const { name, line } of boundCalls(file, ARM_CALL)) {
      if (name === null) {
        missing.push(
          `${file.rel}:${line} — a liveArm(…) call no \`const\` binds`,
        );
        continue;
      }
      const lacks: string[] = [];
      if (!(bound.get(root)?.has(name) ?? false)) lacks.push("server: binding");
      if (!(registered.get(root)?.has(name) ?? false)) {
        lacks.push("web: FieldPresentation.Register");
      }
      if (lacks.length > 0) {
        missing.push(`${file.rel}:${line} — ${name} (${lacks.join(", ")})`);
      }
    }
  }
  return missing;
}

const armsRegistered: Check = {
  id: "live:arms-registered",
  // INPUT-KEYED: a pure scan of tracked sources.
  inputKeyed: true,
  description:
    "Every union arm declared by fields (`const x = liveArm(…)`, network/live) is bound by its own plugin's server — named in its `server/` (the union's arm binding, e.g. `defineRunKind({ columns: x })`) — and registered by its own plugin's web — `FieldPresentation.Register({ owner: x })` — outside test code. A half missing leaves the arm's rows without their slice, or its fields absent from every list of the union.",
  async run() {
    const root = await getWorktreeRoot();
    const declaring = await listCandidateSources({
      root,
      grepArg: "liveArm(",
      fixed: true,
    });
    const roots = new Set(
      declaring
        .filter(notTest)
        .map((f) => pluginRootOf(f.rel))
        .filter((r): r is string => r !== null),
    );
    if (roots.size === 0) return { ok: true };
    // The arms' own plugins' server and web sources, whatever they name.
    const own = await listCandidateSources({
      root,
      grepArg: ".",
      pathspecs: [...roots].flatMap((r) => [
        `${r}/server/*.ts`,
        `${r}/web/*.ts`,
        `${r}/web/*.tsx`,
      ]),
    });
    const missing = unregisteredArms(declaring, own, own);
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} union arm(s) are not bound and registered by their own plugin:\n    ${missing.join("\n    ")}`,
      hint: "In the arm's plugin, bind the arm from its server (`defineRunKind({ columns: arm, … })` for a run kind) and contribute `FieldPresentation.Register({ owner: arm })` (network/live/web) from its web barrel.",
    };
  },
};

export default [exposuresRegistered, armsRegistered];
