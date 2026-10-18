import { join } from "path";
import {
  matchBracket,
  walkFiles,
  readIfExists,
  readStringLiteral,
  findImports,
  maskSource,
  markerCallSpans,
  lineAt,
  type MarkerCallSpan,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { PaneDeclaration, RouteDeclaration, SourceRef } from "../../core";

// ── Types ──────────────────────────────────────────────────────────

export interface ImportBinding {
  local: string;
  original: string;
  module: string;
}

// ── Helpers ────────────────────────────────────────────────────────

export function parseImports(src: string): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  // `findImports` masks strings/comments/regex fully and reads each specifier
  // back by offset, so an import written inside a string can never register a
  // phantom binding. The old namedRe/defRe were `import`-only and never matched
  // a whole-statement `import type …` or a namespace `import * as X`, so those
  // are filtered out to keep behavior identical.
  for (const imp of findImports(src)) {
    if (imp.keyword !== "import") continue;
    if (imp.sideEffect) continue;
    if (imp.typeOnly) continue;
    const clause = imp.clause;
    if (/^\s*\*\s/.test(clause)) continue; // namespace `import * as X`
    const mod = imp.specifier;
    const braceIdx = clause.indexOf("{");
    if (braceIdx < 0) {
      // Default-only `import Foo from` — the whole clause is the local id (defRe).
      const head = clause.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(head)) {
        map.set(head, { local: head, original: "default", module: mod });
      }
      continue;
    }
    // Default alongside named (`import Foo, { … } from`) — the namedRe m[1] branch.
    const defMatch = clause.slice(0, braceIdx).match(/([A-Za-z_$][\w$]*)\s*,/);
    if (defMatch) {
      const defLocal = defMatch[1]!;
      map.set(defLocal, { local: defLocal, original: "default", module: mod });
    }
    const closeIdx = clause.indexOf("}", braceIdx);
    const names = clause.slice(
      braceIdx + 1,
      closeIdx < 0 ? clause.length : closeIdx,
    );
    for (const raw of names.split(",")) {
      let s = raw.trim();
      if (!s) continue;
      s = s.replace(/^type\s+/, "");
      const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch)
        map.set(asMatch[2]!, {
          local: asMatch[2]!,
          original: asMatch[1]!,
          module: mod,
        });
      else if (/^\w+$/.test(s))
        map.set(s, { local: s, original: s, module: mod });
    }
  }
  return map;
}

/** Inner offsets of the `contributions: [ … ]` array body (into the buffer). */
export interface ContributionsBlock {
  /** Offset of the first char *inside* the `[`. */
  start: number;
  /** Offset of the closing `]`. */
  end: number;
}

/**
 * Locate the `contributions: [ … ]` array over a FULLY-MASKED buffer (string /
 * comment / regex interiors blanked) so a `contributions: [` written inside a
 * string or template literal can never match. `maskSource` preserves every
 * offset 1:1, so the returned bounds index straight back into the original.
 */
export function extractContributionsBlock(
  masked: string,
): ContributionsBlock | null {
  const idx = masked.search(/\bcontributions\s*:\s*\[/);
  if (idx < 0) return null;
  const start = masked.indexOf("[", idx);
  const end = matchBracket(masked, start, "[", "]");
  if (end < 0) return null;
  return { start: start + 1, end };
}

/**
 * Find each top-level `Head.member(...)` contribution call inside the block,
 * regardless of argument shape — an inline object literal (`Cell({ … })`), a
 * pre-built const (`DataViewSlots.Filter(textOperatorSet)`), a helper call, or a
 * spread. The call is *located* over `maskedBlock` (fully masked, so a call
 * written inside a string literal in a fixture/docs snippet has vanished, and
 * matchBracket never trips on a bracket inside a string), while `callee` and
 * `argsBody` are *sliced from `origBlock`* at the matched offsets — so a real
 * call's blanked string args (`{ pane: "editorPane" }`) are recovered intact.
 * `maskedBlock` and `origBlock` are the same slice of the masked / original
 * buffers, so their offsets align 1:1.
 *
 * `argsBody` is the inline object-literal body when the first argument is `{ … }`
 * (fed to `parsePropsBlock`), else "" — the slot identity comes from the callee,
 * not the argument. Requiring an inline literal here is exactly what dropped every
 * `DataViewSlots.Filter(<const>)` contribution from the closure graph. Nested
 * dotted calls inside an argument are skipped by resuming the scan past each
 * call's balanced `)`.
 */
export function findCalls(
  maskedBlock: string,
  origBlock: string,
): { callee: string; argsBody: string }[] {
  const out: { callee: string; argsBody: string }[] = [];
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g; // no `{` requirement
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskedBlock))) {
    const callee = origBlock.slice(m.index, m.index + m[1]!.length);
    const openIdx = m.index + m[0].length - 1; // index of "("
    const closeParen = matchBracket(maskedBlock, openIdx, "(", ")");
    if (closeParen < 0) continue;
    // Inline object-literal argument → keep its body for parsePropsBlock.
    let argsBody = "";
    let j = openIdx + 1;
    while (j < maskedBlock.length && /\s/.test(maskedBlock[j]!)) j++;
    if (maskedBlock[j] === "{") {
      const closeBrace = matchBracket(maskedBlock, j, "{", "}");
      if (closeBrace >= 0) argsBody = origBlock.slice(j + 1, closeBrace);
    }
    out.push({ callee, argsBody });
    re.lastIndex = closeParen + 1; // resume AFTER this call → skip nested dotted calls in args
  }
  return out;
}

export function parsePropsBlock(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const len = body.length;
  const skipWs = () => {
    while (i < len && /\s/.test(body[i]!)) i++;
  };
  const skipString = (quote: string) => {
    i++;
    while (i < len && body[i] !== quote) {
      if (body[i] === "\\") i++;
      i++;
    }
    i++;
  };
  const parseValue = (): string => {
    skipWs();
    if (i >= len) return "";
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      skipString(c);
      return body.slice(start, i);
    }
    if (c === "{" || c === "[") {
      const open = c;
      const close = c === "{" ? "}" : "]";
      const start = i;
      const end = matchBracket(body, i, open, close);
      i = end < 0 ? len : end + 1;
      return body.slice(start, i);
    }
    let depth = 0;
    const start = i;
    while (i < len) {
      const ch = body[i]!;
      if (depth === 0 && ch === ",") break;
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") depth--;
      else if (ch === '"' || ch === "'" || ch === "`") {
        skipString(ch);
        continue;
      }
      i++;
    }
    return body.slice(start, i).trim();
  };
  while (i < len) {
    skipWs();
    const rest = body.slice(i);
    // A spread (`...operators`) contributes no prop this parse can read; skip
    // it, so the literal props beside it (`match`, `companion`) still are.
    if (rest.startsWith("...")) {
      i += 3;
      parseValue();
      skipWs();
      if (body[i] === ",") i++;
      continue;
    }
    const keyMatch = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
    if (!keyMatch) break;
    const key = keyMatch[1]!;
    i += keyMatch[0].length;
    const val = parseValue();
    out[key] = val;
    skipWs();
    if (body[i] === ",") i++;
  }
  return out;
}

// ── Marker-call scanning ───────────────────────────────────────────
//
// Both scanners below follow the one sanctioned shape: FULL-mask the source so a
// call written inside a comment, string, or template literal (a test fixture, a
// docs snippet, a codegen template) can't register a phantom declaration, locate
// genuine calls over the mask with `markerCallSpans`, and read the binding name
// and every value back from the ORIGINAL by offset (`maskSource` preserves every
// offset 1:1). Never a hand-rolled `const X = defineRoute(` regex over raw
// source — that is the class `no-adhoc-binding-scan` bans.

const ROUTE_MARKER = "defineRoute";
const PANE_MARKER = "Pane.define";

/** `const <VarName> = ` immediately before a call identifier. Anchored, non-global. */
const DECL_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/**
 * The single object-literal argument's body, sliced from the ORIGINAL, or null
 * when the call's first argument is not an inline `{ … }`.
 */
function objectArgBody(
  masked: string,
  src: string,
  span: MarkerCallSpan,
): string | null {
  let braceStart = span.open + 1;
  while (braceStart < span.close && /\s/.test(masked[braceStart]!))
    braceStart++;
  if (masked[braceStart] !== "{") return null;
  const braceEnd = matchBracket(masked, braceStart, "{", "}");
  if (braceEnd < 0) return null;
  return src.slice(braceStart + 1, braceEnd);
}

/**
 * Offset just past a **top-level** `<field>:` in an already-masked object body,
 * or null when the field is absent. Nested `{}` / `[]` / `()` blocks are skipped
 * whole, so a `title: { useText: … }` or an `options: { id: … }` can never shadow
 * the key being read — the depth-0 rule, which is not optional here: a pane body
 * carries nested objects that spell the very same keys.
 *
 * The depth-0 walk duplicates parse-utils' own private `keyValueOffset` (which
 * `parseStringField` reaches through its `depth0` option). It is restated here
 * because this file also needs the offset for an IDENTIFIER value (`route:
 * buildRoute`), and parse-utils exposes no reader for that — `parseStringField`
 * would report it as `dynamic`, whose `expr` snippet is an error-message string,
 * not a value. Exporting a `parseIdentifierField` from parse-utils would delete
 * this copy.
 */
function topLevelFieldOffset(masked: string, field: string): number | null {
  const re = new RegExp(
    `\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`,
    "y",
  );
  let i = 0;
  while (i < masked.length) {
    const c = masked[i]!;
    if (c === "{" || c === "[" || c === "(") {
      const close = matchBracket(masked, i, c, CLOSERS[c]!);
      if (close < 0) return null; // unbalanced → give up
      i = close + 1;
      continue;
    }
    re.lastIndex = i;
    if (re.test(masked)) return re.lastIndex; // sticky match lands on the value
    i++;
  }
  return null;
}

/**
 * A top-level field's static string value, or null when the field is absent or
 * its value is not a static literal (an identifier, a call, a concatenation, an
 * interpolated template) — the answer a static scanner can honestly give. An
 * EMPTY literal comes back as `""`, not as null: only the caller knows whether
 * an empty value is legitimate for the field it asked for.
 */
function stringField(
  body: string,
  masked: string,
  field: string,
): string | null {
  const at = topLevelFieldOffset(masked, field);
  if (at === null) return null;
  const lit = readStringLiteral(body, at);
  return lit.kind === "value" ? lit.value : null;
}

/**
 * A top-level field's value when it is a bare identifier, else null.
 *
 * An identifier that turns out to be a CALLEE is disqualified. Returning it
 * would mint a PHANTOM reference — an inline `route: defineRoute({ … })` read
 * back as the name `defineRoute`, which `relate()` then looks up among the
 * plugin's routes, finds nothing for, and drops. The pane loses its id and
 * nothing anywhere says so. A caller that wants a call's contents reads the
 * call's own shape instead (see the inline arm of `paneDeclarationsIn`).
 *
 * What counts as a call is decided by `markerCallSpans`, not by a local "is the
 * next char an open paren" test: it walks a generic argument list as a BALANCED
 * block, so
 * `defineRoute<{ a: () => void }>({ … })` is recognised as the call it is rather
 * than read as the bare name `defineRoute` — the same blind spot that scanner
 * exists to close.
 *
 * The shape is read off the MASK — comments already blanked to spaces — and the
 * name is sliced from the original at the same offsets, which `maskSource`
 * keeps 1:1.
 */
function identifierField(
  body: string,
  masked: string,
  field: string,
): string | null {
  const at = topLevelFieldOffset(masked, field);
  if (at === null) return null;
  const m = /^[A-Za-z_$][\w$]*/.exec(masked.slice(at));
  if (!m) return null;
  const name = m[0];
  if (markerCallSpans(masked, name).some((s) => s.identifier === at)) {
    return null;
  }
  return body.slice(at, at + name.length);
}

/**
 * Where a name used in one file comes from: the name it is EXPORTED under plus
 * the specifier it was imported through, or — for a name declared in that same
 * file — just the name. `null` for a default import, which is never how a route
 * or a pane is exported and which carries no exported name to resolve.
 */
export function sourceRef(
  local: string,
  imports: Map<string, ImportBinding>,
): SourceRef | null {
  const imp = imports.get(local);
  if (!imp) return { name: local };
  if (imp.original === "default") return null;
  return { name: imp.original, module: imp.module };
}

/**
 * Every `defineRoute()` in ONE source buffer, as `{ name, routeId }`.
 *
 * The cheap `includes` pre-filter is exact, not a heuristic: `markerCallSpans`
 * anchors on the literal marker, so a buffer without that substring holds no
 * call — and skipping the mask for those is what keeps scanning `core/` and
 * `shared/` on top of `web/` from costing a second full-repo masking pass.
 */
export function routeDeclarationsIn(src: string): RouteDeclaration[] {
  const out: RouteDeclaration[] = [];
  if (!src.includes(ROUTE_MARKER)) return out;
  const masked = maskSource(src);
  for (const span of markerCallSpans(masked, ROUTE_MARKER)) {
    const decl = DECL_RE.exec(masked.slice(0, span.identifier));
    if (!decl) continue;
    const body = objectArgBody(masked, src, span);
    if (body === null) continue;
    // An id is what a pane is addressed by, so an empty one is no id at all.
    const routeId = stringField(body, maskSource(body), "id");
    if (routeId) out.push({ name: decl[1]!, routeId });
  }
  return out;
}

/**
 * Every `defineRoute()` in one plugin's `core/`, `shared/` and `web/`.
 *
 * All three runtimes, because a route is declared wherever its consumers can
 * reach it: 12 of the converted panes name a route from their own plugin's
 * `core/`, 7 from ANOTHER plugin's `core/`, and 3 from their own `web/`. The
 * cross-plugin half is joined in `relate()`; this only ever reports what this
 * plugin itself declares.
 */
export function parseRouteDeclarations(pluginDir: string): RouteDeclaration[] {
  const out: RouteDeclaration[] = [];
  const files: string[] = [];
  for (const runtime of ["core", "shared", "web"]) {
    walkFiles(join(pluginDir, runtime), files);
  }
  for (const f of files) {
    const src = readIfExists(f);
    if (src) out.push(...routeDeclarationsIn(src));
  }
  return out;
}

/**
 * The literal `id` of an INLINE `route: defineRoute({ id: "…" })`, or null when
 * the `route:` value is not such a call (or its id is not a static literal).
 *
 * Both readers index the SAME buffer, which is what makes the exact-offset match
 * below sound rather than lucky: `topLevelFieldOffset` returns the offset of the
 * value's first character within `bodyMask`, and a `MarkerCallSpan.identifier` is
 * the offset of the marker's first character in the very buffer it scanned. So
 * the span whose `identifier` equals that offset IS this field's call, and a
 * `defineRoute` nested deeper in the body (an `options: { route: … }` decoy)
 * cannot collide with it — it sits at a different offset.
 */
function inlineRouteId(body: string, bodyMask: string): string | null {
  const at = topLevelFieldOffset(bodyMask, "route");
  if (at === null) return null;
  const span = markerCallSpans(bodyMask, ROUTE_MARKER).find(
    (s) => s.identifier === at,
  );
  if (!span) return null;
  const routeBody = objectArgBody(bodyMask, body, span);
  if (routeBody === null) return null;
  // An id is what a pane is addressed by, so an empty one is no id at all.
  const id = stringField(routeBody, maskSource(routeBody), "id");
  return id ? id : null;
}

/**
 * Every `Pane.define()` in ONE source buffer, with whichever identity the call
 * spells. A `route:` naming a hoisted binding is a REFERENCE — all this half can
 * record is which name in which module, and `relate()` resolves it to that
 * route's own id, routinely across a plugin boundary. A `route:` holding an
 * inline `defineRoute({ id })` needs no join at all: the id is right there on the
 * pane declaration, so it is read straight into `id`.
 *
 * A call spelling neither is a pane this scanner cannot name, and that THROWS —
 * see below. It cannot fire for a `Pane.define` written inside a string, a
 * template literal or a comment: `markerCallSpans` scans the FULL mask, where
 * those interiors are already blanked, so such a call yields no span and this
 * loop never sees it.
 *
 * The pane's identity is deliberately NOT read off the imported pane object,
 * tempting though `pane._internal.id` is: all three surfaces this facet feeds —
 * the Studio Contributions table, the plugin-detail card, and the PR diff — build
 * their tree with `skipBarrelImport: true`, so the runtime half of the facet is
 * empty exactly where the id is needed.
 *
 * `file` is only for the error message; the scan itself needs nothing but `src`.
 */
export function paneDeclarationsIn(
  src: string,
  file?: string,
): PaneDeclaration[] {
  const out: PaneDeclaration[] = [];
  if (!src.includes(PANE_MARKER)) return out;
  const masked = maskSource(src);
  const spans = markerCallSpans(masked, PANE_MARKER);
  if (spans.length === 0) return out;
  const imports = parseImports(src);
  for (const span of spans) {
    const decl = DECL_RE.exec(masked.slice(0, span.identifier));
    if (!decl) continue;
    const body = objectArgBody(masked, src, span);
    if (body === null) continue;
    const bodyMask = maskSource(body);
    const pane: PaneDeclaration = { name: decl[1]! };
    const routeLocal = identifierField(body, bodyMask, "route");
    if (routeLocal) {
      const route = sourceRef(routeLocal, imports);
      if (route) pane.route = route;
    } else {
      const id = inlineRouteId(body, bodyMask);
      if (id) pane.id = id;
    }
    // Not a value to absorb: a pane whose identity the scanner cannot read is a
    // pane that would silently lose its id everywhere this facet is rendered, and
    // no check would notice — `docs/plugins-details.md` gets its pane lines from
    // the runtime `docLabel`, so it stays green while the Studio table, the
    // plugin-detail card and the PR diff all go blank.
    if (!pane.id && !pane.route) {
      const where = file
        ? `${file}:${lineAt(src, span.identifier)}`
        : `line ${lineAt(src, span.identifier)}`;
      const cause = routeLocal
        ? `its \`route: ${routeLocal}\` is a DEFAULT import (no exported name)`
        : "it spells no identity this scanner can read";
      throw new Error(
        [
          `Pane.define declared as \`${decl[1]}\` (${where}) has no readable`,
          `pane id: ${cause}. The two readable spellings are`,
          "`route: someRoute` — a bare identifier declared in this file or",
          "NAMED-imported into it — and an inline `route: defineRoute({ id })`",
          "whose id is a non-empty string literal. A computed route",
          '(`route: makeRoute(x)`) or a built id (`id: prefix + "-x"`) is not',
          "statically readable: hoist the route to a `const` and name it here.",
        ].join(" "),
      );
    }
    out.push(pane);
  }
  return out;
}

/** Every `Pane.define()` in one plugin's `web/`. Panes live nowhere else. */
export function parsePaneDeclarations(pluginDir: string): PaneDeclaration[] {
  const out: PaneDeclaration[] = [];
  const files: string[] = [];
  walkFiles(join(pluginDir, "web"), files);
  for (const f of files) {
    const src = readIfExists(f);
    if (src) out.push(...paneDeclarationsIn(src, f));
  }
  return out;
}
