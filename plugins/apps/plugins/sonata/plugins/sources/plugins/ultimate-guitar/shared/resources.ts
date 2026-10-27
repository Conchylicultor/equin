import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { UgTabSchema } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { UgSearchResultSchema, ultimateGuitarShape } from "../core";

/** The longest query UG's catalog is asked (a longer one is refused `invalid-query`). */
export const UG_SEARCH_QUERY_MAX = 200;

/**
 * The most hits one search answers: UG's mobile `/tab/search` serves one page
 * of at most 50 tabs, and only the first page is asked. The served loader keeps
 * the first this many, so the schema's cap holds.
 */
export const UG_SEARCH_MAX_RESULTS = 50;

/**
 * One search of UG's catalog by free text, keyed by the (trimmed) query: the
 * slim candidate rows the import dialog lists. NO type filtering — UG ignores
 * `type=` on search, so the dialog filters on each row's `type` string.
 *
 * Bounded: the answer is the FIRST page of UG's results, never a paged list,
 * capped at {@link UG_SEARCH_MAX_RESULTS}.
 *
 * On-demand: a third-party answer nothing pushes a change to; a new question
 * is a new tuple.
 *
 * Refusals: `invalid-query` — an empty query, one with leading or trailing
 * whitespace (the caller trims, so one question is one tuple), or one longer
 * than {@link UG_SEARCH_QUERY_MAX}. A query UG matches nothing for is an empty list
 * (UG answers 404), not a refusal; every other UG breakage (signature
 * rotation, a changed response shape, the network) is a failure, so the read's
 * error offers Retry.
 */
export const ugSearch = liveValue("sonata.ultimate-guitar.search", {
  schema: cappedList(UgSearchResultSchema, { max: UG_SEARCH_MAX_RESULTS }),
  params: ["q"],
  refusals: ["invalid-query"],
  load: "on-demand",
});

/**
 * The raw UG tab a pasted tab URL names, fetched from UG's private mobile API
 * (`fetchUgTabContent`): NO persistence, NO parsing of the chord/lyric markup —
 * `content` is verbatim. Read once by the event that asks (the import dialog,
 * the in-player loader) with `useLiveReader`, whose answer feeds a create or
 * the loaded raw.
 *
 * On-demand: a third-party answer nothing pushes a change to.
 *
 * Refusals — answers about the URL, never retried:
 * - `invalid-url` — not a UG tab URL (no tab id in it), or untrimmed (the
 *   caller trims, so one question is one tuple);
 * - `not-found` — UG has no tab with that id.
 *
 * Every other UG breakage (signature rotation, a changed response shape, the
 * network) is a failure: loud, and the reader's promise rejects.
 */
export const ugTab = liveValue("sonata.ultimate-guitar.tab", {
  schema: UgTabSchema,
  params: ["url"],
  refusals: ["invalid-url", "not-found"],
  load: "on-demand",
});

// The UG row of ONE song, read by its `songId` — the persisted tab the player
// hydrates the song from. The side-table holds 0 or 1 row per song (its
// primary key IS the song), so it is a lookup-only collection: it mints
// `sonata.ultimate-guitar.songs:rows` alone. `found: false` is "this song
// carries no UG tab". Bounded by construction: only a song being opened
// subscribes, and a load is one primary-key seek.
export const songUgRows = liveCollection("sonata.ultimate-guitar.songs", {
  from: ultimateGuitarShape,
  id: "songId",
});
