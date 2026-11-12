import type TS from "typescript";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import type {
  Binding,
  CandidatesFor,
  Declaration,
  ExportRef,
  ParsedFile,
  Readout,
  SourceAnalysis,
  SourceSite,
  Unreadable,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import {
  siteOf,
  unreadableAt,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";

// ── investigate:failures-registered, read from the syntax tree ─────────────
// Every question is answered through the shared source analysis
// (`checks/plugins/source-analysis`): which calls declare a collection or arm
// (every alias, barrel and namespace of `liveCollection` / `liveArm`), what a
// declaration's fields hold (constants followed to their `const` initializer
// across files, spreads and namespaces included), and which declaration an
// `Investigate.Register({ owner })` names (through helpers that pass `owner`
// on as a parameter). FAIL-CLOSED: what cannot be read is reported wherever it
// could change the verdict — never skipped.

/** The declaration factories, at the barrel they are published from. */
export const DECLARE_TARGETS = {
  collection: {
    rel: "plugins/network/plugins/live/core/index.ts",
    name: "liveCollection",
  },
  arm: { rel: "plugins/network/plugins/live/core/index.ts", name: "liveArm" },
} as const satisfies Record<"collection" | "arm", ExportRef>;

/** The registration namespace (`Investigate.Register`). */
export const REGISTER_TARGET = {
  rel: "plugins/primitives/plugins/launch/plugins/investigate/web/index.ts",
  name: "Investigate",
} as const satisfies ExportRef;

/** The failure tint: the badge variant reserved for "the one outcome someone must act on". */
const FAILURE_VARIANT = "destructive";

export interface Missing {
  site: SourceSite;
  name: string;
}

export interface FailuresReport {
  /** Every failure-bearing declaration read, registered or not (exempted files left out). */
  bearing: (Missing & { registered: boolean })[];
  /** Failure-bearing declarations no registration names. */
  missing: Missing[];
  /** What could not be read where it could change the verdict. */
  unreadable: Unreadable[];
}

/** What a span of data says about the failure tint. */
interface Tint {
  tinted: boolean;
  /** Spots whose value could not be read — each might have been the tint. */
  unreadable: Unreadable[];
}

const NO_TINT: Tint = { tinted: false, unreadable: [] };

function merge(a: Tint, b: Tint): Tint {
  if (a.tinted || b.tinted) return { tinted: true, unreadable: [] };
  return { tinted: false, unreadable: [...a.unreadable, ...b.unreadable] };
}

const keyOf = (d: { file: ParsedFile; node: TS.Node }) =>
  `${d.file.rel}:${d.node.pos}`;

const notTest = (rel: string) => !isTestCodePath(rel.split("/"));

/** Expression wrappers that do not change the value. */
function unwrap(ts: typeof TS, e: TS.Expression): TS.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}

function propertyName(ts: typeof TS, name: TS.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** The language's own globals a declaration may name: they hold no declared data. */
const BUILTIN_GLOBALS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "Symbol",
  "Date",
  "Math",
  "JSON",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "RegExp",
  "Error",
  "URL",
  "Intl",
]);

function isGlobal(name: string): boolean {
  return BUILTIN_GLOBALS.has(name);
}

export function createFailureReader(ts: typeof TS, analysis: SourceAnalysis) {
  /** A `const` declaration's tint, read once per run (a cycle reads as untinted). */
  const constTints = new Map<string, Promise<Tint>>();

  /** The value a name refers to, as data: its `const` initializer, or why it has none. */
  async function valueOf(
    file: ParsedFile,
    id: TS.Identifier,
  ): Promise<
    | { kind: "expr"; file: ParsedFile; expr: TS.Expression; key: string }
    | { kind: "namespace"; rel: string }
    | { kind: "none" }
    | { kind: "unreadable"; unreadable: Unreadable }
  > {
    const b = await analysis.bindingOf(file, id);
    if (b.kind === "unreadable") {
      if (isGlobal(id.text)) return { kind: "none" };
      return b;
    }
    return declarationValue(b.value);
  }

  function declarationValue(
    b: Binding,
  ):
    | { kind: "expr"; file: ParsedFile; expr: TS.Expression; key: string }
    | { kind: "namespace"; rel: string }
    | { kind: "none" }
    | { kind: "unreadable"; unreadable: Unreadable } {
    if (b.kind === "external") return { kind: "none" };
    if (b.kind === "namespace") return { kind: "namespace", rel: b.rel };
    const d = b.declaration;
    // Code, not data: a function, class or enum declaration holds no field option.
    if (
      ts.isFunctionDeclaration(d.node) ||
      ts.isClassDeclaration(d.node) ||
      ts.isClassExpression(d.node) ||
      ts.isFunctionExpression(d.node) ||
      ts.isEnumDeclaration(d.node)
    )
      return { kind: "none" };
    const init = analysis.initializerOf(d);
    if (init.kind === "unreadable") return init;
    return { kind: "expr", file: d.file, expr: init.value, key: keyOf(d) };
  }

  /** `ns.name` / `const.name`: what the member names, when it can be read. */
  async function memberValue(
    file: ParsedFile,
    access: TS.PropertyAccessExpression,
  ): Promise<
    | { kind: "expr"; file: ParsedFile; expr: TS.Expression; key: string }
    | { kind: "whole" }
    | { kind: "none" }
    | { kind: "unreadable"; unreadable: Unreadable }
  > {
    const target = unwrap(ts, access.expression);
    if (!ts.isIdentifier(target)) return { kind: "whole" };
    const v = await valueOf(file, target);
    if (v.kind === "expr") {
      // `fields.config` of a `const fields = { config: …, … }`: that property
      // alone; a spread could hold it, so then the whole object is read.
      const obj = unwrap(ts, v.expr);
      if (!ts.isObjectLiteralExpression(obj)) return { kind: "whole" };
      if (obj.properties.some((p) => ts.isSpreadAssignment(p)))
        return { kind: "whole" };
      for (const p of obj.properties) {
        if (p.name === undefined) continue;
        if (propertyName(ts, p.name) !== access.name.text) continue;
        if (ts.isPropertyAssignment(p))
          return {
            kind: "expr",
            file: v.file,
            expr: p.initializer,
            key: `${v.key}.${access.name.text}`,
          };
        if (ts.isShorthandPropertyAssignment(p)) {
          const inner = await valueOf(v.file, p.name);
          return inner.kind === "namespace" ? { kind: "whole" } : inner;
        }
        return { kind: "none" }; // a method or accessor: code
      }
      return { kind: "whole" };
    }
    if (v.kind !== "namespace") return { kind: "whole" };
    const b = await analysis.exportedBinding(v.rel, access.name.text);
    if (b.kind === "unreadable") return b;
    const m = declarationValue(b.value);
    if (m.kind === "namespace") return { kind: "whole" };
    return m;
  }

  /** The tint of a `const`'s value, memoized by its declaration. */
  function constTint(
    file: ParsedFile,
    expr: TS.Expression,
    key: string,
  ): Promise<Tint> {
    let hit = constTints.get(key);
    if (hit === undefined) {
      constTints.set(key, Promise.resolve(NO_TINT)); // a cycle adds nothing
      hit = tintOf(file, expr);
      constTints.set(key, hit);
    }
    return hit;
  }

  /**
   * The strings a `variant` value can be: literals, through constants,
   * namespace members and both arms of a conditional — or Unreadable.
   */
  async function variantValues(
    file: ParsedFile,
    expr: TS.Expression,
    seen: ReadonlySet<string> = new Set(),
  ): Promise<Readout<string[]>> {
    const e = unwrap(ts, expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
      return { kind: "read", value: [e.text] };
    if (ts.isConditionalExpression(e)) {
      const a = await variantValues(file, e.whenTrue, seen);
      if (a.kind === "unreadable") return a;
      const b = await variantValues(file, e.whenFalse, seen);
      if (b.kind === "unreadable") return b;
      return { kind: "read", value: [...a.value, ...b.value] };
    }
    const followed = ts.isIdentifier(e)
      ? await valueOf(file, e)
      : ts.isPropertyAccessExpression(e)
        ? await memberValue(file, e)
        : null;
    if (followed?.kind === "expr" && !seen.has(followed.key))
      return variantValues(
        followed.file,
        followed.expr,
        new Set(seen).add(followed.key),
      );
    if (followed?.kind === "unreadable") return followed;
    return {
      kind: "unreadable",
      unreadable: unreadableAt(
        file,
        expr,
        "a `variant` whose value is not a string literal (or a `const` holding one) — write the literal, or a `const` of it, so the failure tint can be read.",
      ),
    };
  }

  /**
   * Whether a span of DATA carries the failure tint: object and array
   * literals, spreads, call arguments, and every name followed to its `const`.
   * Function bodies, callees and types are code, not data — not read.
   */
  async function tintOf(file: ParsedFile, node: TS.Node): Promise<Tint> {
    if (ts.isTypeNode(node) || ts.isFunctionLike(node)) return NO_TINT;
    if (ts.isPropertyAssignment(node)) {
      // A `variant` holding a call is a FIELD named variant (`variant:
      // enumTextField(…)`, `variant: z.string()`), not an option's tint: data.
      const value = unwrap(ts, node.initializer);
      if (
        propertyName(ts, node.name) === "variant" &&
        !ts.isCallExpression(value) &&
        !ts.isNewExpression(value)
      ) {
        const v = await variantValues(file, node.initializer);
        if (v.kind === "unreadable")
          return { tinted: false, unreadable: [v.unreadable] };
        return { tinted: v.value.includes(FAILURE_VARIANT), unreadable: [] };
      }
      return tintOf(file, node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      if (node.name.text === "variant") {
        const v = await variantValues(file, node.name);
        if (v.kind === "unreadable")
          return { tinted: false, unreadable: [v.unreadable] };
        return { tinted: v.value.includes(FAILURE_VARIANT), unreadable: [] };
      }
      return tintOfName(file, node.name);
    }
    if (ts.isIdentifier(node)) return tintOfName(file, node);
    if (ts.isPropertyAccessExpression(node)) {
      const m = await memberValue(file, node);
      if (m.kind === "whole") return tintOf(file, node.expression);
      if (m.kind === "none") return NO_TINT;
      if (m.kind === "unreadable")
        return { tinted: false, unreadable: [m.unreadable] };
      return ts.isFunctionLike(m.expr)
        ? NO_TINT
        : constTint(m.file, m.expr, m.key);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let t = NO_TINT;
      for (const arg of node.arguments ?? []) {
        t = merge(t, await tintOf(file, arg));
        if (t.tinted) return t;
      }
      return t;
    }
    if (
      ts.isTaggedTemplateExpression(node) ||
      ts.isTemplateExpression(node) ||
      ts.isComputedPropertyName(node)
    )
      return NO_TINT;
    let t = NO_TINT;
    const children: TS.Node[] = [];
    ts.forEachChild(node, (c) => {
      children.push(c);
    });
    for (const child of children) {
      t = merge(t, await tintOf(file, child));
      if (t.tinted) return t;
    }
    return t;
  }

  async function tintOfName(
    file: ParsedFile,
    id: TS.Identifier,
  ): Promise<Tint> {
    const v = await valueOf(file, id);
    switch (v.kind) {
      case "none":
        return NO_TINT;
      case "unreadable":
        return { tinted: false, unreadable: [v.unreadable] };
      case "namespace":
        return {
          tinted: false,
          unreadable: [
            unreadableAt(
              file,
              id,
              "a whole module namespace used as data — name the constant you mean.",
            ),
          ],
        };
      case "expr":
        return ts.isFunctionLike(v.expr)
          ? NO_TINT
          : constTint(v.file, v.expr, v.key);
    }
  }

  /** The top-level keys of a declaration spec — through constants and spreads. */
  async function specKeys(
    file: ParsedFile,
    expr: TS.Expression | undefined,
    at: TS.Node,
  ): Promise<Readout<Set<string>>> {
    const fail = (node: TS.Node): Readout<Set<string>> => ({
      kind: "unreadable",
      unreadable: unreadableAt(
        file,
        node,
        "a declaration spec that is not an object literal (or a `const` of one) — whether it is listed or a union cannot be read.",
      ),
    });
    if (expr === undefined) return fail(at);
    const e = unwrap(ts, expr);
    if (ts.isIdentifier(e)) {
      const v = await valueOf(file, e);
      if (v.kind === "unreadable") return v;
      if (v.kind !== "expr") return fail(e);
      return specKeys(v.file, v.expr, v.expr);
    }
    if (!ts.isObjectLiteralExpression(e)) return fail(e);
    const keys = new Set<string>();
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        const inner = await specKeys(file, p.expression, p);
        if (inner.kind === "unreadable") return inner;
        for (const k of inner.value) keys.add(k);
        continue;
      }
      const name = p.name === undefined ? null : propertyName(ts, p.name);
      if (name === null) return fail(p);
      keys.add(name);
    }
    return { kind: "read", value: keys };
  }

  /** The declaration a name is bound to, keyed as declarations are — or why not. */
  async function declarationOf(
    file: ParsedFile,
    expr: TS.Expression,
  ): Promise<Readout<Declaration>> {
    const e = unwrap(ts, expr);
    if (ts.isIdentifier(e)) {
      const b = await analysis.bindingOf(file, e);
      if (b.kind === "unreadable") return b;
      if (b.value.kind === "declaration")
        return { kind: "read", value: b.value.declaration };
    }
    return {
      kind: "unreadable",
      unreadable: unreadableAt(
        file,
        expr,
        "not a name bound to a declaration — pass the collection (or arm) `const` itself.",
      ),
    };
  }

  return { tintOf, specKeys, declarationOf };
}

/** The `const` a declaration call initializes (through `as` / `satisfies` / parens), or null. */
function boundConst(
  ts: typeof TS,
  file: ParsedFile,
  call: TS.CallExpression,
): { name: string; key: string } | null {
  let n: TS.Node = call;
  while (
    ts.isParenthesizedExpression(n.parent) ||
    ts.isAsExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent)
  )
    n = n.parent;
  const p = n.parent;
  if (
    ts.isVariableDeclaration(p) &&
    p.initializer === n &&
    ts.isIdentifier(p.name) &&
    (p.parent.flags & ts.NodeFlags.Const) !== 0
  )
    return { name: p.name.text, key: keyOf({ file, node: p }) };
  return null;
}

/**
 * Every failure-bearing collection / arm no `Investigate.Register` names.
 * `skips(rel)` drops an exempted declaring file (and what was unreadable for
 * it). Unreadable declarations and registrations are always reported: either
 * could hide a missing registration.
 */
export async function unregisteredFailures(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
  skips: (rel: string) => boolean = () => false,
): Promise<FailuresReport> {
  const reader = createFailureReader(ts, analysis);
  const unreadable: Unreadable[] = [];

  // ── registrations: the declaration each `owner` names ──
  const registered = new Set<string>();
  const regUses = await analysis.usesOf(
    { investigate: REGISTER_TARGET },
    candidatesFor,
  );
  unreadable.push(...regUses.unreadable.filter((u) => notTest(u.site.rel)));
  /** Helpers already followed (a recursive helper adds nothing). */
  const followed = new Set<string>();
  const registerOwner = async (
    file: ParsedFile,
    owner: TS.Expression,
  ): Promise<void> => {
    const d = await reader.declarationOf(file, owner);
    if (d.kind === "unreadable") {
      unreadable.push(d.unreadable);
      return;
    }
    const decl = d.value;
    if (!ts.isParameter(decl.node)) {
      registered.add(keyOf(decl));
      return;
    }
    // A helper passing `owner` on as its parameter: what its callers pass.
    const fn = decl.node.parent;
    const index = fn.parameters.indexOf(decl.node);
    const fnName =
      ts.isFunctionDeclaration(fn) && fn.name !== undefined
        ? fn.name.text
        : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
          ? fn.parent.name.text
          : null;
    const helperKey = keyOf({ file: decl.file, node: fn });
    if (followed.has(helperKey)) return;
    followed.add(helperKey);
    const exported =
      fnName === null
        ? null
        : await analysis.exportedBinding(decl.file.rel, fnName);
    if (
      fnName === null ||
      exported === null ||
      exported.kind === "unreadable" ||
      exported.value.kind !== "declaration"
    ) {
      unreadable.push(
        unreadableAt(
          decl.file,
          fn,
          "a registration whose `owner` is a parameter of a function that is not an exported, named helper — export it so its callers can be read.",
        ),
      );
      return;
    }
    const helperUses = await analysis.usesOf(
      { helper: { rel: decl.file.rel, name: fnName } },
      candidatesFor,
    );
    unreadable.push(
      ...helperUses.unreadable.filter((u) => notTest(u.site.rel)),
    );
    for (const use of helperUses.found) {
      if (!notTest(use.file.rel)) continue;
      if (use.kind !== "call") {
        if (use.kind === "member-call")
          unreadable.push(
            unreadableAt(
              use.file,
              use.call,
              "a registration helper called as a member — call it by name.",
            ),
          );
        continue;
      }
      const arg = use.call.arguments[index];
      if (arg === undefined) {
        unreadable.push(
          unreadableAt(
            use.file,
            use.call,
            "a registration helper called without its `owner`.",
          ),
        );
        continue;
      }
      await registerOwner(use.file, arg);
    }
  };
  for (const use of regUses.found) {
    if (!notTest(use.file.rel)) continue;
    if (use.kind !== "member-call" || use.member !== "Register") continue;
    const arg = use.call.arguments[0];
    const spec = arg === undefined ? undefined : unwrap(ts, arg);
    const owner =
      spec !== undefined && ts.isObjectLiteralExpression(spec)
        ? spec.properties.find(
            (p) =>
              (ts.isPropertyAssignment(p) ||
                ts.isShorthandPropertyAssignment(p)) &&
              propertyName(ts, p.name) === "owner",
          )
        : undefined;
    if (owner === undefined) {
      unreadable.push(
        unreadableAt(
          use.file,
          use.call,
          "an `Investigate.Register` whose argument is not an object literal with an `owner` — write `{ owner: <collection>, … }` at the call.",
        ),
      );
      continue;
    }
    await registerOwner(
      use.file,
      ts.isPropertyAssignment(owner)
        ? owner.initializer
        : (owner as TS.ShorthandPropertyAssignment).name,
    );
  }

  // ── declarations ──
  const declUses = await analysis.usesOf(DECLARE_TARGETS, candidatesFor);
  unreadable.push(
    ...declUses.unreadable.filter(
      (u) => notTest(u.site.rel) && !skips(u.site.rel),
    ),
  );
  interface Decl {
    kind: "collection" | "arm";
    file: ParsedFile;
    call: TS.CallExpression;
    bound: { name: string; key: string } | null;
    tint: Tint;
  }
  const decls: Decl[] = [];
  for (const use of declUses.found) {
    if (use.kind !== "call" || !notTest(use.file.rel)) continue;
    const args =
      use.key === "arm" ? use.call.arguments.slice(1) : use.call.arguments;
    let tint = NO_TINT;
    for (const a of args) {
      tint = merge(tint, await reader.tintOf(use.file, a));
      if (tint.tinted) break;
    }
    decls.push({
      kind: use.key,
      file: use.file,
      call: use.call,
      bound: boundConst(ts, use.file, use.call),
      tint,
    });
  }

  // A UNION's tint (its base outcome) is answered by its arms — the rows a
  // list shows are each arm's — so the union itself is never reported, and
  // every `liveArm(<union>, …)` carries the union's tint.
  const unionTint = new Map<string, Tint>();
  const keysOf = new Map<Decl, Set<string>>();
  for (const d of decls) {
    if (d.kind !== "collection") continue;
    const keys = await reader.specKeys(d.file, d.call.arguments[1], d.call);
    if (keys.kind === "unreadable") {
      if (!skips(d.file.rel)) unreadable.push(keys.unreadable);
      continue;
    }
    keysOf.set(d, keys.value);
    if (!keys.value.has("arms")) continue;
    if (d.bound === null) {
      // Its arms could not be tied to it: their union tint would be lost.
      if (!skips(d.file.rel))
        unreadable.push(
          unreadableAt(
            d.file,
            d.call,
            "a union collection not bound to a `const` of its own — its arms name it by that `const`.",
          ),
        );
      continue;
    }
    unionTint.set(d.bound.key, d.tint);
  }

  const missing: Missing[] = [];
  const bearing: FailuresReport["bearing"] = [];
  for (const d of decls) {
    if (skips(d.file.rel)) continue;
    const isRegistered = d.bound !== null && registered.has(d.bound.key);
    let tint = d.tint;
    if (d.kind === "collection") {
      const keys = keysOf.get(d);
      if (keys === undefined) continue; // reported unreadable above
      // A union is answered by its arms; a lookup-only collection (no
      // `default` window, no `all` set) is read by id and listed by nothing.
      if (keys.has("arms") || !(keys.has("default") || keys.has("all")))
        continue;
    } else {
      const union = d.call.arguments[0];
      const u =
        union === undefined ? null : await reader.declarationOf(d.file, union);
      if (u === null || u.kind === "unreadable") {
        unreadable.push(
          u?.unreadable ??
            unreadableAt(d.file, d.call, "a `liveArm` without its union."),
        );
        continue;
      }
      const ofUnion = unionTint.get(keyOf(u.value));
      if (ofUnion !== undefined) tint = merge(tint, ofUnion);
    }
    const at = {
      site: siteOf(d.file, d.call),
      name: d.bound?.name ?? "(an unbound declaration)",
    };
    if (tint.tinted) {
      bearing.push({ ...at, registered: isRegistered });
      if (!isRegistered) missing.push(at);
    } else if (!isRegistered) unreadable.push(...tint.unreadable);
  }
  return { bearing, missing, unreadable: dedupe(unreadable) };
}

function dedupe(us: Unreadable[]): Unreadable[] {
  const seen = new Set<string>();
  return us.filter((u) => {
    const k = `${u.site.rel}:${u.site.line}:${u.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
