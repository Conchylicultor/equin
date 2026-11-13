import { inlineBoundary, type AnyIdKind } from "@plugins/ids/core";

/**
 * Where an id chip belongs — the literal values of inline-chip's
 * `ChipSurface`, restated here because the SERVER half needs them too (does a
 * page block's doc hold this chip → it needs an `Editor.InlineToken`) and
 * inline-chip's type lives in its web barrel.
 */
export type IdChipSurface = "transcript" | "document";

/**
 * THE inline pattern of a kind's chip: `inlineBoundary(kind.pattern)`, or —
 * for a family whose chip may name a VIEW of the referent after the id (a
 * prototype's variant: `proto-…?pane=floating`) — the id optionally followed
 * by `qualifier`. Both runtimes build it here, so the chip's pattern and its
 * server halves' (`Editor.InlineToken`, `InlineTokenReferentSource`) are the
 * same source — the join key `active-data:document-chip-has-server-token` /
 * `resolved-chip-has-referent` match on — by construction, as long as the
 * family hands both halves the same `qualifier` (kept in its own `core/`).
 *
 * Memoized per kind and qualifier so every reader holds one RegExp object.
 */
const patterns = new WeakMap<AnyIdKind, Map<string, RegExp>>();
export function idChipPattern(kind: AnyIdKind, qualifier?: RegExp): RegExp {
  let byQualifier = patterns.get(kind);
  if (!byQualifier) {
    byQualifier = new Map();
    patterns.set(kind, byQualifier);
  }
  const key = qualifier?.source ?? "";
  let pattern = byQualifier.get(key);
  if (!pattern) {
    pattern = inlineBoundary(
      qualifier === undefined
        ? kind.pattern
        : new RegExp(`(?:${kind.pattern.source})(?:${qualifier.source})?`),
    );
    byQualifier.set(key, pattern);
  }
  return pattern;
}

/**
 * A chip token split into the referent's id and the qualifier written after
 * it (`""` when none) — the id is the kind's pattern matched at the token's
 * start. Throws on a token that does not start with an id of `kind`: only a
 * match of {@link idChipPattern} is handed here.
 */
export function splitIdChipToken(
  kind: AnyIdKind,
  token: string,
): { id: string; qualifier: string } {
  const match = new RegExp(`^(?:${kind.pattern.source})`).exec(token);
  if (match === null) {
    throw new Error(
      `${JSON.stringify(token)} does not start with a ${kind.prefix} id`,
    );
  }
  return { id: match[0], qualifier: token.slice(match[0].length) };
}

/** The tag a model reads a resolved id as: `<task id="…" title="…"/>`. */
export function idReferentTag(kind: AnyIdKind): string {
  return kind.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
