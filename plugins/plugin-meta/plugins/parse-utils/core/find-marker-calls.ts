import { matchBracket } from "./helpers";
import { maskSource } from "./mask-source";

export interface MarkerCall {
  /** Index of the marker identifier's first char in the ORIGINAL source. */
  index: number;
  /** Text between the call's `(` and balanced `)`, sliced from the ORIGINAL source. */
  argsText: string;
}

/** Byte offsets (into the scanned source) of one `marker[<…>](…)` call. */
export interface MarkerCallSpan {
  /** Index of the marker identifier's first char. */
  identifier: number;
  /** Index of the call's opening `(`. */
  open: number;
  /** Index of the matching closing `)`. */
  close: number;
}

/**
 * Find the byte span of every genuine `marker[<…>](…)` call in ALREADY-MASKED
 * source — the single `<…>`-tolerant call scanner every resource-shaped scanner
 * (`findMarkerCalls`, the `no-db-backed-notify` and `keyed-resource-scope`
 * checks, and any future one) routes through, so none of them can ever again
 * SILENTLY under-match the generic call form.
 *
 * The caller masks first (with whatever `maskSource` options it needs — strings
 * blanked or kept) and passes the masked text; because `maskSource` preserves
 * every offset 1:1, the returned indices map straight back to the original.
 *
 * CAUTION — this is only string-embedding-safe when the caller passes a FULL
 * mask (`maskSource(src)`, strings blanked): a strings-kept mask
 * (`{ strings: false }`) leaves a `defineX("id")` written inside a string
 * literal visible, so it is matched as a real call. A marker-value scan must
 * full-mask here and read the value from the ORIGINAL by offset (see
 * `findMarkerCalls`).
 *
 * Detection: `\b<marker>` then an OPTIONAL generic argument list then the call
 * `(`. The generic argument list is skipped as a FULLY BALANCED type-arg block
 * (`skipTypeArgs` below), not a shallow `<[^()]*?>` — a type argument routinely
 * contains parens (`ComponentType<{ close: () => void }>`), and the shallow skip
 * stopped at the first `(`/`)` and silently dropped the whole call. The balanced
 * skip counts `<`/`>` nesting while ignoring the `>` in arrow tokens (`=>`), so
 * function types inside the generic don't prematurely close it; `{}`/`()` inside
 * don't affect angle depth. Tolerating `<…>` is what fixes the generic blind
 * spot: `defineResource<T>(…)`, `defineExternalResource<T, P>(…)`, and
 * `defineRenderSlot<{ f: () => void }>(…)` are matched exactly like the plain form.
 *
 * The leading `\b` plus the literal marker means a marker is never matched inside
 * a longer identifier — e.g. scanning for `defineResource` never hits
 * `defineExternalResource` (which is `define`+`External`+`Resource`, with no
 * `defineResource` substring). A `.`-member prefix (`h.runtime.defineResource(`)
 * still anchors via the `\b` after the `.`. A marker occurrence NOT followed by a
 * call `(` (after optional generics + whitespace) is not a call and is skipped.
 *
 * The argument span is walked with `matchBracket`, which skips string/comment
 * interiors itself — so a stray `)` inside a string in the args can never throw
 * off the paren depth, whether or not the caller blanked strings. An unbalanced
 * call (no matching `)`) is skipped rather than emitted. `marker` is a plain
 * identifier; regex metacharacters in it are escaped.
 */
export function markerCallSpans(masked: string, marker: string): MarkerCallSpan[] {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor only the marker identifier; the (optional) generic block and the call
  // `(` are walked structurally after it so a paren-containing type argument
  // can't fool a fixed regex.
  const re = new RegExp(`\\b${escaped}`, "g");
  const out: MarkerCallSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    let i = m.index + m[0].length;
    while (i < masked.length && /\s/.test(masked[i]!)) i++;
    // Optional generic type-argument block (may contain parens / arrow types).
    if (masked[i] === "<") {
      const after = skipTypeArgs(masked, i);
      if (after >= 0) {
        i = after;
        while (i < masked.length && /\s/.test(masked[i]!)) i++;
      }
    }
    // Not a call unless the next non-space char is the opening `(`.
    if (masked[i] !== "(") {
      // Resume right after the marker identifier (guaranteed forward progress).
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    const open = i;
    const close = matchBracket(masked, open, "(", ")");
    if (close < 0) {
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    out.push({ identifier: m.index, open, close });
    // Resume past this call's closing paren so a nested marker call isn't
    // double-read.
    re.lastIndex = close + 1;
  }
  return out;
}

/**
 * From `<` at `masked[start]`, return the index just past the matching `>` of a
 * TypeScript type-argument block, or -1 if unbalanced. Counts `<`/`>` nesting but
 * ignores the `>` in arrow tokens (`=>`) — type args routinely contain function
 * types like `() => void`, whose `>` is not an angle-bracket closer. (`{}` and
 * `()` inside don't affect angle depth.) `masked` must have comments/regex blanked
 * so a `<` in a comment can't open a phantom block.
 */
function skipTypeArgs(masked: string, start: number): number {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if (c === "<") depth++;
    else if (c === ">" && masked[i - 1] !== "=") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Find every genuine `marker(…)` call in `src`, skipping occurrences that live
 * inside comments, strings or regex literals.
 *
 * Detection runs against a fully-masked copy (`{ strings: true }`) so a marker
 * name in a comment or string can never be picked up; the args text is sliced
 * from the ORIGINAL source (delimiters/values intact) so callers can parse it
 * with `parseStringField` / `parseBoolField`. The generic call form
 * (`marker<…>(…)`) is matched, via the shared `markerCallSpans` scanner.
 *
 * `marker` is a plain identifier (e.g. `"defineCollectedDir"`). A caller that
 * already holds `maskSource(src)` passes it as `masked`.
 */
export function findMarkerCalls(
  src: string,
  marker: string,
  masked: string = maskSource(src, { strings: true }),
): MarkerCall[] {
  return markerCallSpans(masked, marker).map((s) => ({
    index: s.identifier,
    argsText: src.slice(s.open + 1, s.close),
  }));
}

/** 1-based line number of byte offset `idx` in `src`. */
export function lineAt(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}
