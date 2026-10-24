import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, posix, relative } from "path";
import type TS from "typescript";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// `typescript`'s module object is invariant for the process's lifetime — not a
// tree-derived fact — so a per-process memo is safe. Loaded lazily so this
// module's own top-level import doesn't pay `typescript`'s eval cost during the
// check runner's "load all checks" burst, well before any check's `run()` starts.
// A local memo (not shared with the sibling `index.ts`'s) — matching this
// codebase's per-file-inlined-Check-type convention.
let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

// ---------------------------------------------------------------------------
// Why this check exists.
//
// A pane's IDENTITY — its id, its own URL segment, and whether it is its app's
// landing pane — had nothing static holding it in place. Each third is silent
// in a different way:
//
//   - `paneId` keys persisted `history.state`, so changing one breaks every
//     saved route (a restored tab resolves to a pane that no longer exists).
//     Nothing compares it against anything.
//   - `segment` is checked only for COLLISIONS (`pane:segments-unique`, in the
//     sibling `index.ts`) — a segment that merely CHANGES collides with
//     nothing and passes.
//   - `appIndex` has no static enforcement in either direction. Registry sync
//     throws on a segment-bearing index pane and on a second index for one app,
//     but a pane that simply LOSES `appIndex: true` is silent: the field is
//     optional, `pane:segments-unique` skips empty segments, and `type-check`
//     sees nothing. The only symptom is the app's bare root painting an empty
//     main area — which is why the only way to catch it so far was to open each
//     app root and look (`e2e/app-index-sweep.ts`, a manual script).
//
// So the three fields are pinned the one way a value with no derivable truth
// can be pinned: against a committed manifest that a human reviewed. A diff in
// the manifest IS the review — "this commit changes pane identity, here is
// exactly how" — which is what makes an identity-touching refactor (moving a
// file-local `const x = defineRoute(…)` INLINE into the `Pane.define({ route })`
// beside it, across ~70 files) reviewable at all.
//
// WHAT IT READS, AND WHY THAT SURVIVES THE INLINING. The scan is a TypeScript
// AST walk, not a line scan, and it matches a `defineRoute` call at ANY depth —
// so `route: someRoute` and `route: defineRoute({ … })` are the same thing to
// it, and the inline migration is a no-op in its output BY CONSTRUCTION. That
// is the whole point: a reader that could only see the hoisted form would go
// blank exactly when the migration ran.
//
// NOTHING IS SKIPPED. A `Pane.define` this reader cannot name is a hole in the
// guarantee, not a pane to pass over: every unreadable site is collected and
// FAILS the check with its file:line, so the manifest can never quietly cover
// fewer panes than the repo has.
// ---------------------------------------------------------------------------

/**
 * One pane's identity, as the committed manifest records it.
 *
 * `segment` is the string literal AS AUTHORED, not the runtime-normalized form
 * (`Pane.define` strips leading slashes). The stricter value is the right one
 * here: this manifest is about what the source says, and a rewrite that is a
 * no-op at runtime is still an edit to a pane's identity that a reviewer should
 * see go by.
 */
export interface PaneIdentity {
  paneId: string;
  segment: string;
  appIndex: boolean;
  /**
   * The DIRECT parent route's id, or null for a parentless route. One hop, not
   * the ancestor chain: the chain is a derived walk, and recording it would
   * restate every ancestor's identity in every descendant's row, so one edit
   * would churn many lines of the manifest.
   */
  parent: string | null;
}

/** The committed manifest, beside this check. */
export const SNAPSHOT_FILE = join(import.meta.dir, "identity-snapshot.json");

/** The one writer of {@link SNAPSHOT_FILE} — named here so no message hardcodes its path. */
const WRITER_FILE = join(import.meta.dir, "write-identity-snapshot.ts");

/** The copy-pasteable regeneration command, derived rather than spelled out. */
function regenCommand(root: string): string {
  return `./equin run ${relative(root, WRITER_FILE)}`;
}

// Files that may author a pane identity: any source calling `defineRoute` or
// `Pane.define`. ONE `-E` alternation over both tokens, because the two halves
// of an identity routinely sit in different files: 19 of the panes name a route
// promoted to a `core/routes.ts`, so their `panes.tsx` matches only
// `Pane.define` and the route file only `defineRoute`. A candidate set built
// from either token alone would be missing one half of those.
const GREP_ARG = "defineRoute|Pane\\.define";

// Tests are excluded on both spellings: they register throwaway panes that never
// ship, and a fixture pane in the manifest would make every suite edit an
// identity change. `__tests__/` is excluded as a directory too — the jsdom
// suites live there, and a future non-`.test.tsx` fixture inside one would
// otherwise leak in.
const PATHSPECS = [
  "plugins/**/*.ts",
  "plugins/**/*.tsx",
  ":(exclude)**/*.test.ts",
  ":(exclude)**/*.test.tsx",
  ":(exclude)**/__tests__/**",
];

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

function literalText(ts: typeof TS, node: TS.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function isDefineRouteCall(ts: typeof TS, node: TS.CallExpression): boolean {
  const callee = node.expression;
  return ts.isIdentifier(callee) && callee.text === "defineRoute";
}

// `Pane.define({ … })` — the only spelling that mints a pane. Generic arguments
// (`Pane.define<Params>({ … })`) leave the callee untouched, so they are read
// the same way.
function isPaneDefineCall(ts: typeof TS, node: TS.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Pane" &&
    callee.name.text === "define"
  );
}

/** What a `defineRoute({ … })` object literal says, before any cross-file join. */
interface RouteRead {
  id: string;
  segment: string;
  /** The `parent:` identifier AS WRITTEN, or null when the route declares none. */
  parentName: string | null;
}

/** A `const <name> = defineRoute({ … })` binding, with the file it sits in. */
interface RouteDecl {
  name: string;
  exported: boolean;
  file: string;
  line: number;
  /** null when the call's fields are not static literals — never silently dropped. */
  read: RouteRead | null;
}

/** A named import, as `local name → (exported name, specifier)`. */
interface ImportBinding {
  original: string;
  module: string;
}

/** A readable `Pane.define` site, awaiting the cross-file route join. */
interface PaneSite {
  file: string;
  line: number;
  route: TS.Expression;
  appIndex: boolean;
}

/** Everything one source file contributes, plus the scope a name resolves in. */
interface FileScan {
  file: string;
  imports: Map<string, ImportBinding>;
  routesByName: Map<string, RouteDecl>;
  panes: PaneSite[];
}

/**
 * Read a `defineRoute({ … })` object literal. Null when a field this manifest
 * records is not a static literal — the honest answer for a static reader, and
 * one the caller turns into a named failure rather than a missing row.
 *
 * `segment: ""` is a VALUE, not an absence (it is the shape every index pane
 * has), so the emptiness tests below are `=== null`, never truthiness. An empty
 * `id` is the opposite: a pane is addressed by its id, so `""` is no id at all.
 *
 * A spread (`...base`) can supply any of these fields from somewhere this reader
 * cannot see, so it disqualifies the whole literal rather than being stepped
 * over — stepping over it would report the route as parentless (or as having the
 * id the visible half happens to spell), which is worse than reporting nothing.
 */
function readRouteObject(
  ts: typeof TS,
  obj: TS.ObjectLiteralExpression,
): RouteRead | null {
  let id: string | null = null;
  let segment: string | null = null;
  let parentName: string | null = null;
  let parentDeclared = false;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    if (ts.isShorthandPropertyAssignment(prop)) {
      // `{ parent }` names a variable called `parent`; `{ id }` / `{ segment }`
      // name variables where a literal is required, so they are unreadable.
      if (prop.name.text !== "parent") return null;
      parentDeclared = true;
      parentName = prop.name.text;
      continue;
    }
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    switch (prop.name.text) {
      case "id":
        id = literalText(ts, prop.initializer);
        break;
      case "segment":
        segment = literalText(ts, prop.initializer);
        break;
      case "parent":
        parentDeclared = true;
        parentName = ts.isIdentifier(prop.initializer)
          ? prop.initializer.text
          : null;
        break;
      default:
        break;
    }
  }

  if (id === null || id === "" || segment === null) return null;
  if (parentDeclared && parentName === null) return null;
  return { id, segment, parentName };
}

/** The single object-literal argument of a call, or null when it is not one. */
function objectArg(
  ts: typeof TS,
  call: TS.CallExpression,
): TS.ObjectLiteralExpression | null {
  const first = call.arguments[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) return null;
  return first;
}

/**
 * Everything one file says about pane identity. `problems` is appended to, never
 * returned through — a site this reader cannot name must reach the verdict, and
 * the only way to guarantee that is for the skip and the report to be the same
 * statement.
 */
function scanFile(
  ts: typeof TS,
  file: string,
  src: string,
  problems: string[],
): FileScan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lineOf = (node: TS.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const at = (node: TS.Node): string => `${file}:${lineOf(node)}`;

  const scan: FileScan = {
    file,
    imports: new Map(),
    routesByName: new Map(),
    panes: [],
  };

  // Named value imports only. A `import type { … }` binding can never be the
  // `route:` a pane is built from, and a default import carries no exported name
  // to join on (routes and panes are never default-exported).
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      scan.imports.set(el.name.text, {
        original: (el.propertyName ?? el.name).text,
        module: spec.text,
      });
    }
  }

  const visit = (node: TS.Node): void => {
    // `const <name> = defineRoute({ … })` — the hoisted route form. Read at any
    // depth so a route declared inside a block still registers.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isDefineRouteCall(ts, node.initializer)
    ) {
      const obj = objectArg(ts, node.initializer);
      scan.routesByName.set(node.name.text, {
        name: node.name.text,
        exported:
          (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0,
        file,
        line: lineOf(node),
        read: obj === null ? null : readRouteObject(ts, obj),
      });
    }

    if (ts.isCallExpression(node) && isPaneDefineCall(ts, node)) {
      const obj = objectArg(ts, node);
      if (obj === null) {
        problems.push(
          `${at(node)}  Pane.define is not called with an inline object literal, ` +
            `so its identity cannot be read statically`,
        );
      } else {
        let route: TS.Expression | null = null;
        let appIndex = false;
        let appIndexBroken = false;
        let spread = false;
        for (const prop of obj.properties) {
          // A spread can supply `route:` or `appIndex:` from a value this reader
          // cannot follow, so it disqualifies the call. Reading the visible half
          // would silently report `appIndex: false` for a pane that spreads in a
          // `true` — the exact failure this manifest exists to catch.
          if (ts.isSpreadAssignment(prop)) {
            spread = true;
            continue;
          }
          if (ts.isShorthandPropertyAssignment(prop)) {
            // `{ route }` — the value is the identifier the key names.
            if (prop.name.text === "route") route = prop.name;
            else if (prop.name.text === "appIndex") appIndexBroken = true;
            continue;
          }
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            continue;
          }
          if (prop.name.text === "route") route = prop.initializer;
          else if (prop.name.text === "appIndex") {
            const kind = prop.initializer.kind;
            if (kind === ts.SyntaxKind.TrueKeyword) appIndex = true;
            else if (kind === ts.SyntaxKind.FalseKeyword) appIndex = false;
            else appIndexBroken = true;
          }
        }
        if (spread) {
          problems.push(
            `${at(node)}  Pane.define spreads another object into its arguments, ` +
              `so \`route:\` / \`appIndex:\` may come from somewhere this reader ` +
              `cannot follow`,
          );
        } else if (appIndexBroken) {
          problems.push(
            `${at(node)}  \`appIndex\` is not a boolean literal, so whether this ` +
              `pane is its app's landing pane cannot be read statically`,
          );
        } else if (route === null) {
          problems.push(
            `${at(node)}  Pane.define declares no \`route:\`, so it has no ` +
              `readable identity`,
          );
        } else {
          scan.panes.push({ file, line: lineOf(node), route, appIndex });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scan;
}

// ---------------------------------------------------------------------------
// Cross-file resolution
//
// ~19 of the panes name a route promoted to a `core/routes.ts` — its own
// plugin's or another's — so a per-file reader alone would go blind on a fifth
// of the repo. The join mirrors what the contributions facet already does for
// pane ids (`facets/plugins/contributions/facet/internal/static-parse.ts`):
// resolve the local name to the name it is EXPORTED under, then look that up
// across every scanned file. The specifier disambiguates when one exported name
// is declared twice.
// ---------------------------------------------------------------------------

interface GlobalIndex {
  byExportName: Map<string, RouteDecl[]>;
  byFile: Map<string, FileScan>;
}

/**
 * The repo-relative directory (or module file stem) a specifier points at, or
 * null when it names a package rather than a path. Used only to DISAMBIGUATE a
 * name declared more than once — never to resolve one, so the barrel hop
 * (`@plugins/x/core` → `core/index.ts` → `./routes`) it cannot follow costs
 * nothing.
 */
function specifierTarget(spec: string, fromFile: string): string | null {
  if (spec.startsWith("@plugins/")) {
    return `plugins/${spec.slice("@plugins/".length)}`;
  }
  if (spec.startsWith(".")) {
    return posix.normalize(posix.join(posix.dirname(fromFile), spec));
  }
  return null;
}

function declaredUnder(decl: RouteDecl, target: string): boolean {
  return (
    decl.file === `${target}.ts` ||
    decl.file === `${target}.tsx` ||
    decl.file.startsWith(`${target}/`)
  );
}

type Resolved<T> = { ok: true; value: T } | { ok: false; why: string };

/** The `const <name> = defineRoute(…)` a name refers to, from `ctx`'s scope. */
function resolveDecl(
  name: string,
  ctx: FileScan,
  index: GlobalIndex,
): Resolved<RouteDecl> {
  const local = ctx.routesByName.get(name);
  if (local) return { ok: true, value: local };

  const imported = ctx.imports.get(name);
  if (!imported) {
    return {
      ok: false,
      why: `\`${name}\` is neither declared in this file nor named-imported into it`,
    };
  }

  const candidates = index.byExportName.get(imported.original) ?? [];
  if (candidates.length === 0) {
    return {
      ok: false,
      why:
        `\`${name}\` is imported from "${imported.module}" as ` +
        `\`${imported.original}\`, but no exported \`const ${imported.original} = ` +
        `defineRoute(…)\` was found in the scanned sources`,
    };
  }
  if (candidates.length === 1) return { ok: true, value: candidates[0]! };

  const target = specifierTarget(imported.module, ctx.file);
  const narrowed =
    target === null
      ? candidates
      : candidates.filter((d) => declaredUnder(d, target));
  if (narrowed.length === 1) return { ok: true, value: narrowed[0]! };
  // Nothing under the specifier's directory means the narrowing told us nothing
  // (a barrel hop this reader does not follow), so name every candidate rather
  // than the empty narrowed set.
  const ambiguous = narrowed.length === 0 ? candidates : narrowed;
  return {
    ok: false,
    why:
      `\`${imported.original}\` (from "${imported.module}") is exported as a ` +
      `route by ${ambiguous.length} different files ` +
      `(${ambiguous.map((d) => d.file).join(", ")}) ` +
      `— rename one so the reference is unambiguous`,
  };
}

/** A route expression's fields, plus the file scope its `parent:` resolves in. */
function resolveRoute(
  ts: typeof TS,
  expr: TS.Expression,
  ctx: FileScan,
  index: GlobalIndex,
): Resolved<{ read: RouteRead; scope: FileScan }> {
  // Inline: `route: defineRoute({ … })`. Nothing to join — the identity is right
  // here, and its `parent:` resolves in the pane's own file.
  if (ts.isCallExpression(expr) && isDefineRouteCall(ts, expr)) {
    const obj = objectArg(ts, expr);
    const read = obj === null ? null : readRouteObject(ts, obj);
    if (read === null) {
      return {
        ok: false,
        why: "its inline `defineRoute({ … })` has no static `id` / `segment` string literal",
      };
    }
    return { ok: true, value: { read, scope: ctx } };
  }

  if (!ts.isIdentifier(expr)) {
    return {
      ok: false,
      why: "its `route:` is neither a bare identifier nor an inline `defineRoute({ … })`",
    };
  }

  const decl = resolveDecl(expr.text, ctx, index);
  if (!decl.ok) return decl;
  if (decl.value.read === null) {
    return {
      ok: false,
      why:
        `\`${expr.text}\` (${decl.value.file}:${decl.value.line}) has no static ` +
        `\`id\` / \`segment\` string literal`,
    };
  }
  const scope = index.byFile.get(decl.value.file);
  if (scope === undefined) {
    return { ok: false, why: `no scan for ${decl.value.file}` };
  }
  return { ok: true, value: { read: decl.value.read, scope } };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export type PaneScan =
  { ok: true; panes: PaneIdentity[] } | { ok: false; problems: string[] };

/**
 * Every production pane's identity, read from source.
 *
 * "Production" means every pane DEFINED outside a test — not every pane
 * REGISTERED. Whether a pane reaches the router is a separate
 * `Pane.Register({ pane })` contribution, and a defined-but-unregistered pane
 * still carries an id and a segment that a refactor can change, so it belongs in
 * the manifest.
 */
export async function scanPaneIdentities(): Promise<PaneScan> {
  const ts = await loadTypescript();
  const sources = await listCandidateSources({
    grepArg: GREP_ARG,
    pathspecs: PATHSPECS,
  });

  const problems: string[] = [];
  const scans = sources.map(({ rel, src }) => scanFile(ts, rel, src, problems));

  const index: GlobalIndex = {
    byExportName: new Map(),
    byFile: new Map(scans.map((s) => [s.file, s])),
  };
  for (const scan of scans) {
    for (const decl of scan.routesByName.values()) {
      if (!decl.exported) continue;
      const list = index.byExportName.get(decl.name) ?? [];
      list.push(decl);
      index.byExportName.set(decl.name, list);
    }
  }

  const panes: PaneIdentity[] = [];
  const claimedBy = new Map<string, string>();
  for (const scan of scans) {
    for (const site of scan.panes) {
      const where = `${site.file}:${site.line}`;
      const resolved = resolveRoute(ts, site.route, scan, index);
      if (!resolved.ok) {
        problems.push(`${where}  ${resolved.why}`);
        continue;
      }
      const { read, scope } = resolved.value;

      let parent: string | null = null;
      if (read.parentName !== null) {
        const parentDecl = resolveDecl(read.parentName, scope, index);
        if (!parentDecl.ok) {
          problems.push(
            `${where}  its route's \`parent: ${read.parentName}\` is unreadable: ${parentDecl.why}`,
          );
          continue;
        }
        if (parentDecl.value.read === null) {
          problems.push(
            `${where}  its route's parent \`${read.parentName}\` ` +
              `(${parentDecl.value.file}:${parentDecl.value.line}) has no static \`id\``,
          );
          continue;
        }
        parent = parentDecl.value.read.id;
      }

      const owner = claimedBy.get(read.id);
      if (owner !== undefined) {
        problems.push(
          `${where}  pane id "${read.id}" is already claimed by ${owner} — ` +
            `two panes cannot share one id (the router throws on the duplicate ` +
            `at registry sync, and one of them would win at random here)`,
        );
        continue;
      }
      claimedBy.set(read.id, where);
      panes.push({
        paneId: read.id,
        segment: read.segment,
        appIndex: site.appIndex,
        parent,
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems: problems.sort() };
  return { ok: true, panes };
}

// ---------------------------------------------------------------------------
// The committed manifest
// ---------------------------------------------------------------------------

function byPaneId(a: PaneIdentity, b: PaneIdentity): number {
  return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
}

/**
 * The manifest's exact bytes. Sorted by `paneId` and 2-space pretty-printed with
 * a trailing newline, so a review diff shows moved identities and nothing else —
 * the file is not prettier-formatted (the format pass covers `.ts` only), so
 * this function IS its formatting contract.
 */
function serializeSnapshot(panes: PaneIdentity[]): string {
  const sorted = [...panes].sort(byPaneId).map((p) => ({
    paneId: p.paneId,
    segment: p.segment,
    appIndex: p.appIndex,
    parent: p.parent,
  }));
  return `${JSON.stringify({ panes: sorted }, null, 2)}\n`;
}

/** Overwrite {@link SNAPSHOT_FILE} with `panes`. The one writer. */
export function writeIdentitySnapshot(panes: PaneIdentity[]): void {
  writeFileSync(SNAPSHOT_FILE, serializeSnapshot(panes));
}

function isPaneIdentity(value: unknown): value is PaneIdentity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.paneId === "string" &&
    typeof v.segment === "string" &&
    typeof v.appIndex === "boolean" &&
    (v.parent === null || typeof v.parent === "string")
  );
}

/**
 * The committed manifest's rows. A malformed file is a failure with a name, not
 * an empty list: read as "no panes", it would report every pane in the repo as
 * newly added and bury the real cause.
 */
function readSnapshot(text: string): Resolved<PaneIdentity[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return { ok: false, why: `not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, why: "top level is not an object" };
  }
  const raw: unknown = (parsed as { panes?: unknown }).panes;
  if (!Array.isArray(raw)) return { ok: false, why: "no `panes` array" };
  const rows: PaneIdentity[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPaneIdentity(entry)) {
      return {
        ok: false,
        why: "a `panes` entry is not { paneId: string, segment: string, appIndex: boolean, parent: string | null }",
      };
    }
    rows.push(entry);
  }
  return { ok: true, value: rows };
}

function describeIdentity(p: PaneIdentity): string {
  const parent = p.parent === null ? "no parent" : `parent "${p.parent}"`;
  return `segment "${p.segment}", appIndex ${p.appIndex}, ${parent}`;
}

function describeChange(before: PaneIdentity, after: PaneIdentity): string {
  const parts: string[] = [];
  if (before.segment !== after.segment) {
    parts.push(`segment "${before.segment}" → "${after.segment}"`);
  }
  if (before.appIndex !== after.appIndex) {
    parts.push(`appIndex ${before.appIndex} → ${after.appIndex}`);
  }
  if (before.parent !== after.parent) {
    parts.push(`parent ${before.parent ?? "null"} → ${after.parent ?? "null"}`);
  }
  return parts.join(", ");
}

const check: Check = {
  id: "pane:identity-manifest",
  description:
    "every pane's id, URL segment, appIndex and parent route match the committed identity manifest",
  async run() {
    const root = await getWorktreeRoot();
    const regen = regenCommand(root);
    const snapshotRel = relative(root, SNAPSHOT_FILE);

    const scan = await scanPaneIdentities();
    if (!scan.ok) {
      return {
        ok: false,
        message:
          `${scan.problems.length} pane(s) whose identity cannot be read from source:\n` +
          scan.problems.map((p) => `  ${p}`).join("\n"),
        hint:
          "A pane this reader cannot name is a pane the manifest silently stops " +
          "covering, so it fails rather than passes over. The two readable " +
          "spellings are `route: someRoute` — a bare identifier declared in this " +
          "file or named-imported into it — and an inline " +
          '`route: defineRoute({ id: "…", segment: "…" })`. A computed route ' +
          "(`route: makeRoute(x)`) or a built id is not statically readable: " +
          "hoist the route to a `const` and name it here.",
      };
    }

    if (!existsSync(SNAPSHOT_FILE)) {
      return {
        ok: false,
        message: `${snapshotRel} is missing — there is nothing to compare ${scan.panes.length} pane identities against.`,
        hint:
          `Generate it with:\n  ${regen}\n` +
          "then READ the diff before committing — the file is the reviewed record " +
          "of every pane's id, segment, appIndex and parent, so generating it is " +
          "how you assert those are the values you meant.",
      };
    }

    const committed = readSnapshot(readFileSync(SNAPSHOT_FILE, "utf8"));
    if (!committed.ok) {
      return {
        ok: false,
        message: `${snapshotRel} is unreadable: ${committed.why}`,
        hint: `Regenerate it with:\n  ${regen}`,
      };
    }

    const before = new Map(committed.value.map((p) => [p.paneId, p]));
    const after = new Map(scan.panes.map((p) => [p.paneId, p]));

    const added = [...after.values()]
      .filter((p) => !before.has(p.paneId))
      .sort(byPaneId);
    const removed = [...before.values()]
      .filter((p) => !after.has(p.paneId))
      .sort(byPaneId);
    const changed = [...after.values()]
      .flatMap((now) => {
        const then = before.get(now.paneId);
        if (then === undefined) return [];
        const diff = describeChange(then, now);
        return diff === "" ? [] : [{ paneId: now.paneId, diff }];
      })
      .sort((a, b) => (a.paneId < b.paneId ? -1 : 1));

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return { ok: true };
    }

    const sections: string[] = [];
    if (changed.length > 0) {
      sections.push(
        `${changed.length} pane(s) whose identity CHANGED:\n` +
          changed.map((c) => `  ${c.paneId}: ${c.diff}`).join("\n"),
      );
    }
    if (removed.length > 0) {
      sections.push(
        `${removed.length} pane(s) in the manifest that no longer exist:\n` +
          removed
            .map((p) => `  ${p.paneId} (${describeIdentity(p)})`)
            .join("\n"),
      );
    }
    if (added.length > 0) {
      sections.push(
        `${added.length} pane(s) not in the manifest:\n` +
          added.map((p) => `  ${p.paneId} (${describeIdentity(p)})`).join("\n"),
      );
    }

    return {
      ok: false,
      message: `${snapshotRel} does not match the panes in this tree.\n${sections.join("\n")}`,
      hint:
        "If every line above is a change you MEANT, record it:\n" +
        `  ${regen}\n` +
        "and commit the regenerated manifest alongside the change.\n" +
        "If a line surprises you, it is the bug this check exists for. A changed " +
        "`paneId` breaks every saved route (it keys `history.state`, so a " +
        "restored tab resolves to a pane that no longer exists). A lost " +
        "`appIndex: true` makes that app's bare root paint an EMPTY main area — " +
        "silent everywhere else, which is why it is pinned here.",
    };
  },
};

export default check;
