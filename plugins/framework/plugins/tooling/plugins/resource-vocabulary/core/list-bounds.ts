import {
  markerCallSpans,
  maskSource,
  matchBracket,
  parseStringField,
  readStringLiteral,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// A declaration's list bounds as source text says them — `list-bound`'s
// markers (`wholeList` / `wholeRecord` → `whole: <reason>`, `cappedList` /
// `cappedRecord` → `capped: <max>`) — one more declaration trait the
// descriptor index reads (`DescriptorInfo.lists`), so the docs facet prints
// the bound next to the resource. The markers are the only source: a serve
// call names no bound (research/2026-10-22-global-live-bounds-independent-of-freshness.md).

/** One source file of the plugin being scanned (structurally the index's `SourceFile`). */
interface ConstSource {
  src: string;
}

/** `list-bound`'s markers: the wrapper each declares a list's bound with. */
const LIST_BOUND_MARKERS = {
  wholeList: "reason",
  wholeRecord: "reason",
  cappedList: "max",
  cappedRecord: "max",
} as const;

/**
 * The list bounds a declaration writes, as labels (`whole: <reason>`,
 * `capped: <max>`, each once, in the order met): every `list-bound` marker
 * call in its args, then — transitively — in the initializer of each
 * module-level const of its plugin the text names (a schema declared beside
 * the value, an item schema in a sibling file). A marker inside a schema
 * imported from ANOTHER plugin is not seen. THROWS on a `reason:` that is not
 * a string literal (or a module-level const of one) — the docs print it.
 */
export function declaredListBounds(
  argsText: string,
  consts: Map<string, string>,
  where: { file: string; line: number },
): string[] {
  const labels: string[] = [];
  const visited = new Set<string>();
  const queue = [argsText];
  for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
    const masked = maskSource(text);
    for (const [marker, field] of Object.entries(LIST_BOUND_MARKERS)) {
      if (!masked.includes(marker)) continue;
      for (const span of markerCallSpans(masked, marker)) {
        const args = text.slice(span.open + 1, span.close);
        const argsMasked = masked.slice(span.open + 1, span.close);
        // The options object is the call's last top-level `{ … }`.
        const open = lastTopLevelBrace(argsMasked);
        const body = objectBodyAt(args, argsMasked, open);
        if (body === null) continue;
        const label =
          field === "reason"
            ? `whole: ${listReason(body, marker, consts, where)}`
            : `capped: ${fieldExpr(body, "max") ?? "?"}`;
        if (!labels.includes(label)) labels.push(label);
      }
    }
    for (const ident of masked.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      const init = consts.get(ident);
      if (init === undefined || visited.has(ident)) continue;
      visited.add(ident);
      queue.push(init);
    }
  }
  return labels;
}

/**
 * A whole marker's `reason:` — a string literal, or the identifier of a
 * module-level `const` of the plugin initialized to one (a reason several
 * lists of one payload share); THROWS on anything else.
 */
function listReason(
  body: string,
  marker: string,
  consts: Map<string, string>,
  where: { file: string; line: number },
): string {
  const f = parseStringField(body, "reason", { depth0: true });
  if (f.kind === "value") return f.value;
  if (f.kind === "dynamic" && /^[A-Za-z_$][\w$]*$/.test(f.expr.trim())) {
    const init = consts.get(f.expr.trim())?.trim();
    const lit = init === undefined ? undefined : readStringLiteral(init, 0);
    if (lit?.kind === "value" && lit.end === init!.length) return lit.value;
  }
  throw new Error(
    `${where.file}:${where.line}: a \`${marker}(…)\` in this declaration's schema ` +
      (f.kind === "dynamic"
        ? `has a \`reason:\` that is not a static string literal — got \`${f.expr}\`. `
        : "has no `reason:`. ") +
      "The docs facet prints the reason from source text; write the literal at the marker.",
  );
}

/** The source text of `field:`'s value at depth 0 of an object body, trimmed — or undefined. */
function fieldExpr(body: string, field: string): string | undefined {
  const masked = maskSource(body);
  const re = new RegExp(`\\b${field}\\s*:\\s*`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (depthAt(masked, m.index) !== 0) continue;
    const start = m.index + m[0].length;
    let end = start;
    let depth = 0;
    for (; end < masked.length; end++) {
      const c = masked[end];
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (c === "," && depth === 0) break;
      if (depth < 0) break;
    }
    return body.slice(start, end).trim();
  }
  return undefined;
}

/** Offset of the last `{` at depth 0 of `masked`, or -1. */
function lastTopLevelBrace(masked: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" && depth === 0) last = i;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return last;
}

/**
 * Every module-level `const <name> = <initializer>;` of the plugin's files, by
 * name — the initializer's ORIGINAL text, read up to its `;` at depth 0. A
 * name declared in two files keeps the first.
 */
export function moduleConstInitializers(
  files: readonly ConstSource[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { src } of files) {
    const masked = maskSource(src);
    const re =
      /(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let end = start;
      for (; end < masked.length; end++) {
        const c = masked[end];
        if (c === "{" || c === "[" || c === "(") depth++;
        else if (c === "}" || c === "]" || c === ")") depth--;
        else if (c === ";" && depth === 0) break;
      }
      if (!out.has(m[1]!)) out.set(m[1]!, src.slice(start, end));
    }
  }
  return out;
}

/** The text strictly inside the `{ … }` opening at `open` (from the ORIGINAL), or null. */
function objectBodyAt(
  src: string,
  masked: string,
  open: number,
): string | null {
  if (open < 0 || masked[open] !== "{") return null;
  const close = matchBracket(masked, open, "{", "}");
  return close < 0 ? null : src.slice(open + 1, close);
}

/** Bracket depth of `masked` at offset `at` (strings/comments already masked). */
function depthAt(masked: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return depth;
}
