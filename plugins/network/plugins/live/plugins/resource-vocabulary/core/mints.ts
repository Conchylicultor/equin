import {
  maskSource,
  matchBracket,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { DescriptorFactory, MintedResource } from "./vocabulary";

// What ONE factory call mints, read from its source text — the single reading
// both scanners use (the `resources` docs facet and the eager-tier generator;
// A28 of research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md). Two
// readings of `requires` had already drifted: the facet honoured it, the
// eager-tier scan ignored it, so a collection minting `k` under two exclusive
// conditions (a window under `default`, the whole set under `all`) would have
// been pinned twice.

/**
 * The resources one `entry` call with `argsText` (the text between its
 * parentheses) mints, in declaration order: every mint whose `requires` field
 * the call's spec SETS and whose `unless` field it does not (a mint with
 * neither is always minted).
 *
 * The spec is the call's second argument, which must be an inline object
 * literal, and a field counts only at the spec's own depth — `all:` inside
 * `filterable` or a nested object is not the spec's `all`. A dotted field
 * (`paged.meta`) names a field of the spec's inline object `paged`, read at
 * that object's own depth the same way.
 *
 * THROWS when two kept mints share a key (the same suffix): the spec sets two
 * fields whose mints exclude each other — `default` and `all` both mint `k` —
 * which the factory itself refuses at runtime too, so the declaration is
 * wrong, not ambiguous.
 *
 * THROWS, too, when presence cannot be read off the text — it must not guess,
 * since a wrong "absent" silently drops a key (from the docs, and from the
 * eager tier: a `preload: "boot"` key never pinned is a first-paint loading
 * flash with no error): the spec is not an inline object literal (an
 * identifier `spec`, a wrapper call `makeSpec({ … })`, `{ … } as const` — its
 * fields are not in the call's text), the spec spreads another object at its
 * own depth (`{ ...base }` may carry any field), or it names a `requires`
 * field as a shorthand property (`{ row, all }` — no `all:` to find) — and,
 * for a dotted field, the same of each object it is read through, which must
 * itself be an inline object literal. A factory with no conditional mint
 * mints the same set whatever its spec says, so its spec is never read.
 */
export function mintsOf(
  entry: DescriptorFactory,
  argsText: string,
  where: { file: string; line: number },
): readonly MintedResource[] {
  const conditions = new Set(
    entry.mints.flatMap((m) =>
      [m.requires, m.unless].filter((f): f is string => f !== undefined),
    ),
  );
  const spec = conditions.size > 0 ? specBody(argsText, where) : null;
  if (spec !== null) {
    assertReadable(
      spec,
      new Set([...conditions].map((f) => f.split(".")[0]!)),
      where,
    );
  }
  const sets = (field: string): boolean => fieldSet(spec!, field, where);
  const kept = entry.mints.filter(
    (m) =>
      (m.requires === undefined || sets(m.requires)) &&
      (m.unless === undefined || !sets(m.unless)),
  );
  const bySuffix = new Map<string, MintedResource>();
  for (const m of kept) {
    const other = bySuffix.get(m.suffix);
    if (other !== undefined) {
      throw new Error(
        `${where.file}:${where.line}: one declaration mints the key suffix ` +
          `${JSON.stringify(m.suffix)} twice — its spec sets both ` +
          `\`${other.requires ?? "(always)"}\` and \`${m.requires ?? "(always)"}\`, ` +
          "which mint the same resource and exclude each other. Keep one.",
      );
    }
    bySuffix.set(m.suffix, m);
  }
  return kept;
}

/**
 * Whether `spec` (an object literal's body) sets `field` at its own depth — a
 * dotted field through the inline object literals it names (each checked
 * readable on the way down, as the spec is).
 */
function fieldSet(
  spec: string,
  field: string,
  where: { file: string; line: number },
): boolean {
  const [head, ...rest] = field.split(".");
  if (rest.length === 0) {
    return parseStringField(spec, head!, { depth0: true }).kind !== "absent";
  }
  const inner = memberObjectBody(spec, head!, where);
  if (inner === null) return false;
  assertReadable(inner, new Set([rest[0]!]), where);
  return fieldSet(inner, rest.join("."), where);
}

/**
 * The body of the inline object literal `spec`'s own member `name` holds, or
 * `null` when the spec has no `name:` member. Throws when it holds anything
 * else (an identifier, a call): what is inside it cannot be read.
 */
function memberObjectBody(
  spec: string,
  name: string,
  where: { file: string; line: number },
): string | null {
  const masked = maskSource(spec);
  const key = new RegExp(`^${name}\\s*:\\s*`);
  for (const span of depth0Spans(masked)) {
    const m = key.exec(masked.slice(span.start, span.end));
    if (m === null) continue;
    const open = span.start + m[0].length;
    if (
      masked[open] === "{" &&
      matchBracket(masked, open, "{", "}") === span.end - 1
    ) {
      return spec.slice(open + 1, span.end - 1);
    }
    throw new Error(
      `${where.file}:${where.line}: the spec's \`${name}\` ` +
        `(\`${spec.slice(open, span.end).replace(/\s+/g, " ").slice(0, 60)}\`) is not ` +
        "an inline object literal — which resources it mints cannot be read; " +
        "write it inline.",
    );
  }
  return null;
}

/**
 * Refuse a spec whose conditional fields (`requires` / `unless`) cannot be read as `name:` keys at its
 * own depth: a spread member, or a shorthand member naming one of them.
 */
function assertReadable(
  spec: string,
  requires: ReadonlySet<string>,
  where: { file: string; line: number },
): void {
  for (const member of depth0Members(maskSource(spec))) {
    const fields = [...requires].map((r) => `\`${r}\``).join(" / ");
    if (member.startsWith("...")) {
      throw new Error(
        `${where.file}:${where.line}: the spec spreads \`${member}\` — which ` +
          `resources it mints depends on whether it sets ${fields}, and a ` +
          "spread hides that from the scanners. Write the spec's fields inline.",
      );
    }
    if (requires.has(member)) {
      throw new Error(
        `${where.file}:${where.line}: the spec names \`${member}\` as a ` +
          "shorthand property — the scanners read which resources it mints " +
          `from a \`${member}:\` key. Write \`${member}: ${member}\`.`,
      );
    }
  }
}

/**
 * The depth-0 argument spans `[start, end)` of a call's argument text (masked),
 * trimmed; an empty argument (a trailing comma) dropped.
 */
function depth0Spans(masked: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(masked[from] ?? "")) from++;
    while (to > from && /\s/.test(masked[to - 1] ?? "")) to--;
    if (to > from) out.push({ start: from, end: to });
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, masked.length);
  return out;
}

/**
 * The members of an object literal's body (masked text), split at its own
 * depth and trimmed; empty members (a trailing comma) dropped.
 */
function depth0Members(masked: string): string[] {
  return depth0Spans(masked).map((s) => masked.slice(s.start, s.end));
}

/**
 * The text inside the call's spec — its second argument, which must be one
 * inline object literal (opened by its first character, closed by its last).
 * Throws otherwise: what the call mints is unreadable from its text.
 */
function specBody(
  argsText: string,
  where: { file: string; line: number },
): string {
  const masked = maskSource(argsText);
  const arg = depth0Spans(masked)[1];
  if (
    arg !== undefined &&
    masked[arg.start] === "{" &&
    matchBracket(masked, arg.start, "{", "}") === arg.end - 1
  ) {
    return argsText.slice(arg.start + 1, arg.end - 1);
  }
  const written =
    arg === undefined
      ? "no spec"
      : `\`${argsText.slice(arg.start, arg.end).replace(/\s+/g, " ").slice(0, 60)}\``;
  throw new Error(
    `${where.file}:${where.line}: the spec (${written}) is not an inline ` +
      "object literal — which resources it mints cannot be read; write the " +
      "spec inline.",
  );
}
