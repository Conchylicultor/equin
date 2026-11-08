import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type {
  Follow,
  FollowBuilder,
  FollowIdsTarget,
  FollowMap,
} from "@plugins/network/plugins/live/core";

/**
 * What one inline token names, answered on the server: the thing it points at
 * still exists and has this title, or there is no such thing. A failed lookup
 * throws — it is not "not found".
 */
export type InlineTokenReferent =
  { found: true; title: string } | { found: false };

/**
 * How a LIVE value (a backlink's snippet) reads one family's referents — so a
 * rename of the referent reaches exactly the values whose text names it, and
 * no other write reaches them:
 *
 * - `follow` — the referent's row, FOLLOWED by id (network/live's `follows`)
 *   through a served lookup collection that carries exactly what the title
 *   is read from. Built by {@link followedReferent}. A value whose text holds
 *   none of the family's tokens reads nothing of it.
 * - `untracked` — the referent lives outside Postgres (a file): `resolve` is
 *   called at load, and nothing routes its change (`reason` says why that is
 *   the truth). A `resolve` reading a TABLE here would be an undeclared read.
 * - `not-in-text` — the chip never sits in stored text (a transcript-only
 *   chip: no page block holds it as a chip, so its id there is plain
 *   characters); a live renderer leaves the token as written.
 */
export type InlineTokenLiveRead =
  | FollowedReferent
  | { readonly kind: "untracked"; readonly reason: string }
  | { readonly kind: "not-in-text"; readonly reason: string };

/** A family's referents read by id through a served lookup collection ({@link followedReferent}). */
export interface FollowedReferent {
  readonly kind: "follow";
  readonly target: FollowIdsTarget<{ readonly id: string }>;
  /** The row id a matched token names, or `null` for none. */
  readonly idOf: (token: string) => string | null;
  /** What the token resolves to, given its row (`undefined`: no such row). */
  readonly referentOf: (row: never) => InlineTokenReferent;
}

/**
 * A family's live read: its referent rows followed by id through `target` (a
 * served lookup-only collection, the handle `serveCollection` returned),
 * `idOf` naming the row a token points at and `referentOf` reading the title
 * off it — the twin of the family's `resolve`, from the same columns.
 */
export function followedReferent<Row extends { readonly id: string }>(
  target: FollowIdsTarget<Row>,
  spec: {
    idOf: (token: string) => string | null;
    referentOf: (row: Row) => InlineTokenReferent;
  },
): FollowedReferent {
  return {
    kind: "follow",
    target,
    idOf: spec.idOf,
    referentOf: spec.referentOf as (row: never) => InlineTokenReferent,
  };
}

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
 * `live` is how a live value rendering text through
 * {@link inlineTokensAsLiveText} reads the referents
 * ({@link InlineTokenLiveRead}): followed by id, so a rename recomputes only
 * the values whose text names that referent.
 */
export const InlineTokenReferentSource = defineServerContribution<{
  kind: string;
  pattern: RegExp;
  live: InlineTokenLiveRead;
  resolve(token: string): Promise<InlineTokenReferent>;
}>("primitives.text-editor.inline-chip.referent", {
  // The pattern's source, as `Editor.InlineToken`'s: the join key the
  // `active-data:resolved-chip-has-referent` check matches chips against.
  docLabel: (s) => s.pattern.source,
});

/** The follow name of the `i`-th contributed referent source. */
const referentFollow = (i: number) => `referent:${i}` as const;

/** Every match of `pattern` in `text` (global, whatever flags it declares). */
function tokensIn(pattern: RegExp, text: string): string[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((m) => m[0]);
}

/**
 * The follows a live value makes to render texts through
 * {@link inlineTokensAsLiveText}: one per `follow`-read family (named
 * `referent:<i>`), DEPENDENT on `deps` — the follows the texts come from,
 * `textsOf` reading them off their rows. Each follow names the rows its
 * family's tokens in those texts point at, and none when they hold no such
 * token — so a write to a referent no text names reaches nothing. Called
 * inside the value's `follows` (built at the bind, `followsAtBind`: families
 * contribute as the plugin tiers load). Generic: names no family.
 */
export function inlineTokenReferentFollows<S, D extends FollowMap>(
  follow: FollowBuilder<S>,
  deps: D,
  textsOf: (
    rows: Readonly<Record<keyof D, readonly unknown[]>>,
  ) => readonly string[],
): Record<`referent:${number}`, Follow<{ readonly id: string }>> {
  const out: Record<`referent:${number}`, Follow<{ readonly id: string }>> = {};
  InlineTokenReferentSource.getContributions().forEach((source, i) => {
    const live = source.live;
    if (live.kind !== "follow") return;
    out[referentFollow(i)] = follow.from(deps, live.target, (_s, rows) => {
      const ids = new Set<string>();
      for (const text of textsOf(
        rows as Readonly<Record<keyof D, readonly unknown[]>>,
      )) {
        for (const token of tokensIn(source.pattern, text)) {
          const id = live.idOf(token);
          if (id !== null) ids.add(id);
        }
      }
      return ids.size === 0 ? null : { ids: [...ids] };
    });
  });
  return out;
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
  resolverOf: (
    source: InlineTokenReferentSourceSpec,
    index: number,
  ) => ((token: string) => Promise<InlineTokenReferent>) | null = (s) =>
    s.resolve,
): Promise<string> {
  const spans: Span[] = [];
  for (const [
    i,
    source,
  ] of InlineTokenReferentSource.getContributions().entries()) {
    const resolve = resolverOf(source, i);
    if (resolve === null) continue;
    const flags = source.pattern.flags.includes("g")
      ? source.pattern.flags
      : `${source.pattern.flags}g`;
    const matches = [
      ...text.matchAll(new RegExp(source.pattern.source, flags)),
    ];
    const tokens = [...new Set(matches.map((m) => m[0]))];
    const referents = new Map(
      await Promise.all(
        tokens.map(async (t) => [t, await resolve(t)] as const),
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
 * `text` as a PERSON reads it, inside a LIVE value: every token a contributed
 * family resolves is replaced by its referent's title alone — what the chip
 * shows in the app. For plain-text excerpts of stored content (a backlink's
 * snippet), where the XML form {@link expandInlineTokenReferents} hands a
 * model would be noise. A token whose referent does not exist stays as
 * written.
 *
 * Reads only what the value followed: a `follow`-read family's referent is
 * its row in `followed` (the follows {@link inlineTokenReferentFollows} made,
 * by name) — a row the follow did not read is not found; an `untracked`
 * family's is its `resolve`; a `not-in-text` family's token stays as written.
 */
export function inlineTokensAsLiveText(
  text: string,
  followed: Readonly<Record<string, readonly unknown[] | undefined>>,
): Promise<string> {
  return rewriteInlineTokenReferents(
    text,
    (_kind, _token, title) => title,
    (source, i) => {
      const live = source.live;
      if (live.kind === "not-in-text") return null;
      if (live.kind === "untracked") return source.resolve;
      const rows = followed[referentFollow(i)] ?? [];
      const byId = new Map(
        (rows as readonly { readonly id: string }[]).map((r) => [r.id, r]),
      );
      return (token) => {
        const id = live.idOf(token);
        const row = id === null ? undefined : byId.get(id);
        return Promise.resolve(
          row === undefined ? { found: false } : live.referentOf(row as never),
        );
      };
    },
  );
}

type InlineTokenReferentSourceSpec = ReturnType<
  typeof InlineTokenReferentSource.getContributions
>[number];
