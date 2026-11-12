import type TS from "typescript";
import {
  isTestCodePath,
  pluginDirOfRepoPath,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  boundConst,
  declarationKey,
  formatUnreadable,
  siteOf,
  unreadableAt,
  valueReferences,
  type CandidatesFor,
  type Collected,
  type Declaration,
  type ExportRef,
  type ParsedFile,
  type Readout,
  type SourceAnalysis,
  type TargetUse,
  type Unreadable,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";

// The three registration checks of network/live, read from the syntax tree
// through the shared source analysis (`checks/plugins/source-analysis`): which
// calls declare a shape / arm / client-fields set (every alias, barrel and
// namespace of their factories), which `const` each declares (through `as`,
// `satisfies` and either arm of a ternary), and which declarations a
// registration names — each identifier in its arguments taken to the
// declaration it RESOLVES to, never matched by its spelling. FAIL-CLOSED: what
// cannot be read is returned as `unreadable`, never skipped.

/** The factories and registration namespaces, at the barrels they are published from. */
export const LIVE_TARGETS = {
  shape: {
    rel: "plugins/infra/plugins/entity-extensions/core/index.ts",
    name: "defineExtensionShape",
  },
  extension: {
    rel: "plugins/infra/plugins/entity-extensions/server/index.ts",
    name: "defineExtension",
  },
  arm: { rel: "plugins/network/plugins/live/core/index.ts", name: "liveArm" },
  clientFields: {
    rel: "plugins/network/plugins/live/core/index.ts",
    name: "clientFields",
  },
  presentation: {
    rel: "plugins/network/plugins/live/web/index.ts",
    name: "FieldPresentation",
  },
  columns: {
    rel: "plugins/network/plugins/live/server/index.ts",
    name: "LiveColumns",
  },
  resolver: {
    rel: "plugins/network/plugins/live/web/index.ts",
    name: "ClientFields",
  },
} as const satisfies Record<string, ExportRef>;
type LiveKey = keyof typeof LIVE_TARGETS;

/** Every TS source under some directories (repo-relative), test code included. */
export type FilesUnder = (
  dirs: readonly string[],
) => Promise<ReadonlyArray<{ rel: string; src: string }>>;

export interface RegistrationReport {
  /** `path:line — name (what is missing)`, one per unregistered declaration. */
  missing: string[];
  /** What could not be read where it could change the verdict. */
  unreadable: Unreadable[];
}

const notTest = (rel: string) => !isTestCodePath(rel.split("/"));

/**
 * The plugins that define the targets: their own code implements the API
 * (the web barrel spreading the slot facades, the server collecting the
 * contributions), so a use there that is not a call (the facade spread, the
 * contributions read) is not a consumer's and is not reported. Their calls
 * are still read like anyone's.
 */
const OWNER_DIRS = new Set(
  Object.values(LIVE_TARGETS).map((t) => pluginDirOfRepoPath(t.rel)),
);
const consumer = (rel: string) =>
  notTest(rel) && !OWNER_DIRS.has(pluginDirOfRepoPath(rel));

/** The uses of some targets by their consumers (outside test code and the defining plugins), unreadable spots included. */
async function usesOutsideTests<K extends LiveKey>(
  analysis: SourceAnalysis,
  targets: Readonly<Record<K, ExportRef>>,
  candidatesFor: CandidatesFor,
): Promise<Collected<TargetUse<K>>> {
  const uses = await analysis.usesOf(targets, candidatesFor);
  return {
    found: uses.found.filter((u) => notTest(u.file.rel)),
    unreadable: uses.unreadable.filter((u) => consumer(u.site.rel)),
  };
}

/** A declaring call and the `const` it initializes (null when none binds it). */
interface Declared {
  file: ParsedFile;
  call: TS.CallExpression;
  bound: Declaration | null;
}

/**
 * The declaring calls of `key` (`f(…)` — a member call or a value use of the
 * factory is unreadable).
 */
function declaredBy<K extends LiveKey>(
  ts: typeof TS,
  uses: Collected<TargetUse<K>>,
  key: K,
  unreadable: Unreadable[],
): Declared[] {
  const out: Declared[] = [];
  for (const use of uses.found) {
    if (use.kind === "reexport" || use.kind === "reexport-all") continue;
    if (use.key !== key) continue;
    if (use.kind === "member-call") {
      unreadable.push(
        unreadableAt(
          use.file,
          use.call,
          `\`${use.exported}.${use.member}(…)\` — call ${use.exported} directly, so its declaration can be read.`,
        ),
      );
      continue;
    }
    out.push({
      file: use.file,
      call: use.call,
      bound: boundConst(ts, use.file, use.call),
    });
  }
  return out;
}

/** The member calls `<namespace>.<member>(…)` of `key`. */
function memberCalls<K extends LiveKey>(
  uses: Collected<TargetUse<K>>,
  key: K,
  member: string,
): { file: ParsedFile; call: TS.CallExpression }[] {
  const out: { file: ParsedFile; call: TS.CallExpression }[] = [];
  for (const use of uses.found)
    if (use.kind === "member-call" && use.key === key && use.member === member)
      out.push({ file: use.file, call: use.call });
  return out;
}

/**
 * The declarations the value references under `root` resolve to (keyed as
 * declarations are), through imports, aliases, barrels and namespace members.
 * Fail-closed: a reference to a parameter of a function around `root` (a
 * helper the declaration is passed into), a namespace used whole, or one that
 * cannot be resolved is Unreadable — any could have named the declaration.
 */
export async function referencedDeclarations(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  root: TS.Node,
): Promise<Collected<string>> {
  const out: Collected<string> = { found: [], unreadable: [] };
  for (const id of valueReferences(ts, root)) {
    let b = await analysis.bindingOf(file, id);
    if (b.kind === "unreadable") {
      out.unreadable.push(b.unreadable);
      continue;
    }
    if (b.value.kind === "namespace") {
      const p = id.parent;
      if (!(ts.isPropertyAccessExpression(p) && p.expression === id)) {
        out.unreadable.push(
          unreadableAt(
            file,
            id,
            `the namespace \`${id.text}\` is used whole, so which of its exports it names cannot be read; access them by name.`,
          ),
        );
        continue;
      }
      b = await analysis.exportedBinding(b.value.rel, p.name.text);
      if (b.kind === "unreadable") {
        out.unreadable.push(b.unreadable);
        continue;
      }
    }
    if (b.value.kind === "namespace") {
      out.unreadable.push(
        unreadableAt(
          file,
          id,
          `a nested namespace under \`${id.text}\` cannot be followed to the export it names; import it by name.`,
        ),
      );
      continue;
    }
    if (b.value.kind !== "declaration") continue; // npm, a global
    const d = b.value.declaration;
    const inside =
      d.file.rel === file.rel &&
      d.node.pos >= root.pos &&
      d.node.end <= root.end;
    if (!inside && (ts.isParameter(d.node) || ts.isBindingElement(d.node))) {
      let n: TS.Node = d.node;
      while (
        ts.isBindingElement(n) ||
        ts.isObjectBindingPattern(n) ||
        ts.isArrayBindingPattern(n)
      )
        n = n.parent;
      if (ts.isParameter(n)) {
        out.unreadable.push(
          unreadableAt(
            file,
            id,
            `\`${id.text}\` is a parameter — the registration is inside a helper, so which declaration it registers is its callers'; register the declaration directly.`,
          ),
        );
        continue;
      }
    }
    out.found.push(declarationKey(d));
  }
  return out;
}

/** Per plugin directory: every declaration the given calls' arguments name, in its `<runtime>/`. */
async function namedPerPlugin(
  ts: typeof TS,
  analysis: SourceAnalysis,
  calls: readonly { file: ParsedFile; call: TS.CallExpression }[],
  runtime: string,
  unreadable: Unreadable[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const { file, call } of calls) {
    const dir = ownRuntimeDir(file.rel, runtime);
    if (dir === null) continue;
    const named = await referencedDeclarations(ts, analysis, file, call);
    unreadable.push(...named.unreadable);
    let set = out.get(dir);
    if (set === undefined) out.set(dir, (set = new Set()));
    for (const k of named.found) set.add(k);
  }
  return out;
}

/** The plugin directory of a file in that plugin's own `<runtime>/`, else null. */
function ownRuntimeDir(rel: string, runtime: string): string | null {
  const dir = pluginDirOfRepoPath(rel);
  return dir !== null && rel.startsWith(`${dir}/${runtime}/`) ? dir : null;
}

/** A declaration's report line, or the reason its call binds none. */
function siteLine(d: Declared, what: string): string {
  const line = siteOf(d.file, d.call).line;
  return `${d.file.rel}:${line} — ${d.bound?.name ?? `a ${what}(…) call no \`const\` binds`}`;
}

// ── live:exposures-registered ──────────────────────────────────────────────

/**
 * The exposing shapes (outside test code) whose own plugin does not both fold
 * them on its server — `LiveColumns.Expose(h)` of a handle
 * `h = defineExtension(…, <shape>, …)` (or the call inline) — and register
 * them on its web — a `FieldPresentation.Register(…)` naming the shape.
 */
export async function unregisteredExposures(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
): Promise<RegistrationReport> {
  const uses = await usesOutsideTests(
    analysis,
    {
      shape: LIVE_TARGETS.shape,
      extension: LIVE_TARGETS.extension,
      columns: LIVE_TARGETS.columns,
      presentation: LIVE_TARGETS.presentation,
    },
    candidatesFor,
  );
  const unreadable = [...uses.unreadable];
  // Each extension handle → the shapes its call names.
  const handles = new Map<string, Set<string>>();
  for (const ext of declaredBy(ts, uses, "extension", unreadable)) {
    if (ext.bound === null) continue; // only an inline call folds it, read below
    const named = await referencedDeclarations(
      ts,
      analysis,
      ext.file,
      ext.call,
    );
    unreadable.push(...named.unreadable);
    handles.set(declarationKey(ext.bound), new Set(named.found));
  }
  const exposedNames = await namedPerPlugin(
    ts,
    analysis,
    memberCalls(uses, "columns", "Expose"),
    "server",
    unreadable,
  );
  const folded = new Map<string, Set<string>>();
  for (const [dir, names] of exposedNames) {
    const set = new Set(names);
    for (const n of names) for (const s of handles.get(n) ?? []) set.add(s);
    folded.set(dir, set);
  }
  const registered = await namedPerPlugin(
    ts,
    analysis,
    memberCalls(uses, "presentation", "Register"),
    "web",
    unreadable,
  );
  const missing: string[] = [];
  for (const d of declaredBy(ts, uses, "shape", unreadable)) {
    const exposes = await hasOwnKey(
      ts,
      analysis,
      d.file,
      d.call.arguments[0],
      d.call,
      "exposes",
    );
    if (exposes.kind === "unreadable") {
      unreadable.push(exposes.unreadable);
      continue;
    }
    if (!exposes.value) continue;
    if (d.bound === null) {
      missing.push(siteLine(d, "exposing defineExtensionShape"));
      continue;
    }
    const key = declarationKey(d.bound);
    const dir = pluginDirOfRepoPath(d.file.rel) ?? "";
    const lacks: string[] = [];
    if (!(folded.get(dir)?.has(key) ?? false))
      lacks.push("server: LiveColumns.Expose");
    if (!(registered.get(dir)?.has(key) ?? false))
      lacks.push("web: FieldPresentation.Register");
    if (lacks.length > 0)
      missing.push(`${siteLine(d, "")} (${lacks.join(", ")})`);
  }
  return { missing, unreadable };
}

/**
 * Does an object (inline, a `const`, through spreads) have an own `key`?
 * Anything else is Unreadable.
 */
async function hasOwnKey(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  expr: TS.Expression | undefined,
  at: TS.Node,
  key: string,
  seen: Set<string> = new Set(),
): Promise<Readout<boolean>> {
  const fail = (node: TS.Node, reason: string): Readout<boolean> => ({
    kind: "unreadable",
    unreadable: unreadableAt(file, node, reason),
  });
  if (expr === undefined)
    return fail(at, "a declaration with no options cannot be read.");
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  if (ts.isIdentifier(e)) {
    const b = await analysis.bindingOf(file, e);
    if (b.kind === "unreadable") return b;
    if (b.value.kind !== "declaration")
      return fail(e, `\`${e.text}\` is not a \`const\` of the repo.`);
    const d = b.value.declaration;
    const k = declarationKey(d);
    if (seen.has(k)) return fail(e, `\`${e.text}\` refers back to itself.`);
    seen.add(k);
    const init = analysis.initializerOf(d);
    if (init.kind === "unreadable") return init;
    return hasOwnKey(ts, analysis, d.file, init.value, at, key, seen);
  }
  if (!ts.isObjectLiteralExpression(e))
    return fail(
      e,
      "options that are not an object literal (or a `const` holding one) cannot be read — pass them inline.",
    );
  for (const p of e.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = await hasOwnKey(
        ts,
        analysis,
        file,
        p.expression,
        p,
        key,
        seen,
      );
      if (inner.kind === "unreadable" || inner.value) return inner;
      continue;
    }
    const name = p.name;
    if (name === undefined) continue;
    if (ts.isComputedPropertyName(name))
      return fail(p, "a computed key cannot be read — spell the key.");
    if (
      (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
      name.text === key
    )
      return { kind: "read", value: true };
  }
  return { kind: "read", value: false };
}

// ── live:arms-registered ───────────────────────────────────────────────────

/**
 * The arms (outside test code) whose own plugin's `server/` references no
 * binding of them (a reference RESOLVING to the arm — the union's arm binding,
 * `served.arm(x, { … })`), or whose `web/` registers no presentation of them.
 */
export async function unregisteredArms(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
  filesUnder: FilesUnder,
): Promise<RegistrationReport> {
  const uses = await usesOutsideTests(
    analysis,
    { arm: LIVE_TARGETS.arm, presentation: LIVE_TARGETS.presentation },
    candidatesFor,
  );
  const unreadable = [...uses.unreadable];
  const arms = declaredBy(ts, uses, "arm", unreadable);
  const dirs = new Set(
    arms
      .map((a) => pluginDirOfRepoPath(a.file.rel))
      .filter((d): d is string => d !== null),
  );
  // Per plugin: every declaration its server's code references.
  const bound = new Map<string, Set<string>>();
  if (dirs.size > 0) {
    for (const { rel } of await filesUnder(
      [...dirs].map((d) => `${d}/server`),
    )) {
      if (!notTest(rel)) continue;
      const dir = ownRuntimeDir(rel, "server");
      const file = await analysis.file(rel);
      if (dir === null || file === null) continue;
      const named = await referencedDeclarations(ts, analysis, file, file.sf);
      unreadable.push(...named.unreadable);
      let set = bound.get(dir);
      if (set === undefined) bound.set(dir, (set = new Set()));
      for (const k of named.found) set.add(k);
    }
  }
  const registered = await namedPerPlugin(
    ts,
    analysis,
    memberCalls(uses, "presentation", "Register"),
    "web",
    unreadable,
  );
  const missing: string[] = [];
  for (const d of arms) {
    if (d.bound === null) {
      missing.push(siteLine(d, "liveArm"));
      continue;
    }
    const key = declarationKey(d.bound);
    const dir = pluginDirOfRepoPath(d.file.rel) ?? "";
    const lacks: string[] = [];
    if (!(bound.get(dir)?.has(key) ?? false)) lacks.push("server: binding");
    if (!(registered.get(dir)?.has(key) ?? false))
      lacks.push("web: FieldPresentation.Register");
    if (lacks.length > 0)
      missing.push(`${siteLine(d, "")} (${lacks.join(", ")})`);
  }
  return { missing, unreadable };
}

// ── live:client-fields-resolved ────────────────────────────────────────────

/**
 * The client-fields declarations (outside test code) whose own plugin's
 * `web/` resolves none of them — no `ClientFields.Resolve(…)` naming them.
 */
export async function unresolvedClientFields(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
): Promise<RegistrationReport> {
  const uses = await usesOutsideTests(
    analysis,
    {
      clientFields: LIVE_TARGETS.clientFields,
      resolver: LIVE_TARGETS.resolver,
    },
    candidatesFor,
  );
  const unreadable = [...uses.unreadable];
  const resolved = await namedPerPlugin(
    ts,
    analysis,
    memberCalls(uses, "resolver", "Resolve"),
    "web",
    unreadable,
  );
  const missing: string[] = [];
  for (const d of declaredBy(ts, uses, "clientFields", unreadable)) {
    if (d.bound === null) {
      missing.push(siteLine(d, "clientFields"));
      continue;
    }
    const dir = pluginDirOfRepoPath(d.file.rel) ?? "";
    if (!(resolved.get(dir)?.has(declarationKey(d.bound)) ?? false))
      missing.push(siteLine(d, ""));
  }
  return { missing, unreadable };
}

/** A report's lines: each missing declaration, then each spot that could not be read. */
export function reportLines(r: RegistrationReport): string[] {
  return [
    ...r.missing,
    ...new Set(r.unreadable.map((u) => `unreadable: ${formatUnreadable(u)}`)),
  ];
}
