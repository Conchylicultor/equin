import {
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";

/**
 * A composition entry-point pattern. Two forms:
 *
 *  - the ROOT form — exactly `**`, matching every plugin in the graph. The plugin
 *    tree has no root node, so this is the only way to spell "every plugin".
 *  - the ID form — a dot-separated plugin id with an optional trailing `.**`
 *    (whole-subtree).
 *
 * Either form takes an optional leading `!` (negation). No mid-glob — only exact
 * match, `.**` (subtree opt-in), `**` (everything), and `!` (trim). See
 * {@link parseEntryPattern}.
 *
 * `**` / `!` are not valid `PluginId` characters, but nothing derives a
 * filesystem or config path from an entry point (paths come from the
 * composition's own id), so the string alias is operationally safe.
 */
export type EntryPattern = string;

/**
 * A parsed {@link EntryPattern}, as a discriminated union so every consumer is
 * forced by `tsc` to say what it does with the root form (which has no `base` —
 * there is no root plugin id to name).
 *
 *  - `kind: "root"` — the `**` form: every node in the graph.
 *  - `kind: "id"` — a concrete base id, plus whether a `.**` whole-subtree suffix
 *    was present.
 *
 * Both carry the negation flag and the original raw string.
 */
export type ParsedPattern =
  | { kind: "root"; negate: boolean; raw: string }
  | {
      kind: "id";
      negate: boolean;
      base: PluginId;
      subtree: boolean;
      raw: string;
    };

/**
 * Parse an {@link EntryPattern} into its parts: strip a leading `!` (⇒ `negate`),
 * then either recognise the remainder as the root `**` form, or strip a trailing
 * `.**` (⇒ `subtree`) and brand what is left as the `base` {@link PluginId}. The
 * only grammar is a leading `!`, the whole-graph `**`, and a trailing `.**`; a
 * base is treated as an exact id (no mid-glob).
 *
 * **This never throws.** Studio render paths call it on user-typed strings, so a
 * nonsensical pattern must parse into an inert shape rather than crash a render:
 * `"!**"` parses cleanly as a negated root and is refused by the
 * `composition-closure` CHECK (it would empty the bundle), not by an exception
 * here.
 */
export function parseEntryPattern(p: string): ParsedPattern {
  const raw = p;
  let rest = p;
  const negate = rest.startsWith("!");
  if (negate) rest = rest.slice(1);
  if (rest === "**") return { kind: "root", negate, raw };
  const subtree = rest.endsWith(".**");
  if (subtree) rest = rest.slice(0, -".**".length);
  return { kind: "id", negate, base: asPluginId(rest), subtree, raw };
}
