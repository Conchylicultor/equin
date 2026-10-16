import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { RoutedSource } from "@plugins/infra/plugins/query-resource/server";

/**
 * What one inline token names, answered on the server: the thing it points at
 * still exists and has this title, or there is no such thing. A failed lookup
 * throws — it is not "not found".
 */
export type InlineTokenReferent =
  { found: true; title: string } | { found: false };

/**
 * A chip family's server-side reading of its own tokens, for text a MODEL will
 * read. In the app an id like `proto-1789665568-9onf` renders as a chip showing
 * the prototype's title; handed raw to a model it is an opaque string the model
 * copies into its answer ("Proto-1789665568-9onf theme preview"). A family
 * contributes `resolve` so {@link expandInlineTokenReferents} can hand the
 * model what the chip shows instead.
 *
 * `kind` is the tag name the token expands to (`<prototype id="…" title="…"/>`);
 * `pattern` is the SAME regex the chip declares, imported from the family's
 * `core/`, so the two readings cannot drift.
 *
 * `tables` are the BASE tables `resolve` reads (`[]` when it reads none — a
 * file-backed referent). A live value that renders text through
 * {@link inlineTokensAsText} declares them as its reads
 * ({@link inlineTokenReferentTables}), so a rename of the referent recomputes
 * it. Never a view: a resolver reads the base table's column itself.
 */
export const InlineTokenReferentSource = defineServerContribution<{
  kind: string;
  pattern: RegExp;
  readonly tables: readonly RoutedSource[];
  resolve(token: string): Promise<InlineTokenReferent>;
}>("primitives.text-editor.inline-chip.referent", {
  // The pattern's source, as `Editor.InlineToken`'s: the join key the
  // `active-data:resolved-chip-has-referent` check matches chips against.
  docLabel: (s) => s.pattern.source,
});

/**
 * The base tables every contributed referent resolver reads, deduped — what a
 * live value built on {@link inlineTokensAsText} adds to its own declared
 * reads. Read at CALL time (a `reads` thunk): families contribute as the plugin
 * tiers load. Generic: names no family.
 */
export function inlineTokenReferentTables(): RoutedSource[] {
  return [
    ...new Set(
      InlineTokenReferentSource.getContributions().flatMap((s) => s.tables),
    ),
  ];
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

interface Span {
  start: number;
  end: number;
  replacement: string;
}

/**
 * `text` with every token a contributed family recognises and resolves
 * rewritten by `render(kind, token, title)`. A token whose referent does not
 * exist stays as written. Where two families' patterns overlap the one that
 * starts first wins (a `[[page:<id>]]` token over the bare id inside it).
 * Generic: names no family.
 */
async function rewriteInlineTokenReferents(
  text: string,
  render: (kind: string, token: string, title: string) => string,
): Promise<string> {
  const spans: Span[] = [];
  for (const source of InlineTokenReferentSource.getContributions()) {
    const flags = source.pattern.flags.includes("g")
      ? source.pattern.flags
      : `${source.pattern.flags}g`;
    const matches = [
      ...text.matchAll(new RegExp(source.pattern.source, flags)),
    ];
    const tokens = [...new Set(matches.map((m) => m[0]))];
    const referents = new Map(
      await Promise.all(
        tokens.map(async (t) => [t, await source.resolve(t)] as const),
      ),
    );
    for (const m of matches) {
      const referent = referents.get(m[0]);
      if (referent?.found !== true) continue;
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        replacement: render(source.kind, m[0], referent.title),
      });
    }
  }

  // First span wins where two families' patterns overlap; the rest keep order.
  // Equal starts: the LONGER span wins, so a token enclosing another's pattern
  // is read as the enclosing token.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * `text` with every token a contributed family recognises rewritten as
 * `<kind id="<token>" title="<title>"/>`, so a model reads the referent's name
 * next to its id. A token whose referent does not exist stays as written.
 * Generic: names no family — a new chip family is covered the day it
 * contributes an {@link InlineTokenReferentSource}.
 */
export function expandInlineTokenReferents(text: string): Promise<string> {
  return rewriteInlineTokenReferents(
    text,
    (kind, token, title) =>
      `<${kind} id="${escapeAttr(token)}" title="${escapeAttr(title)}"/>`,
  );
}

/**
 * `text` as a PERSON reads it: every token a contributed family resolves is
 * replaced by its referent's title alone — what the chip shows in the app. For
 * plain-text excerpts of stored content (a backlink's snippet), where the XML
 * form {@link expandInlineTokenReferents} hands a model would be noise. A token
 * whose referent does not exist stays as written.
 */
export function inlineTokensAsText(text: string): Promise<string> {
  return rewriteInlineTokenReferents(text, (_kind, _token, title) => title);
}
