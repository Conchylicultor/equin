import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  ChordTokenSchema,
  parseChordToken,
  type ChordToken,
  type TokenSetCount,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  HookpadModeSchema,
  type HookpadMode,
} from "@plugins/integrations/plugins/hooktheory/core";
import {
  CORE_SECTION_ID,
  OTHER_SECTION_ID,
  TRACK_RULES,
  type ChordReader,
  type TrackRule,
} from "./catalog-rules";
import { chordState, type ChordState, type Selection } from "./selection";

// ── The catalog: every chord of the song index, in tracks and sections ──────
//
// Built from the index (`buildCatalog` over the server's `countTokenSets`), so
// the order and the grouping come from what real songs use, not from a hand
// list. Where a chord goes is `catalog-rules.ts`; how often it occurs, and so
// whether it is listed or folded into its section's rare group, is counted
// here. Pure: the server builds it once per loaded index and serves it as
// `chord.catalog`.

/** A chord in at least this share of its section's windows is listed (unless its track sets its own `listedShare`). */
export const LISTED_SHARE = 0.01;
/** A section with this many rare chords or fewer lists them instead of folding them. */
export const MAX_FOLDED_RARE = 2;

/**
 * Why the catalog's lists are loaded whole: the catalog is read entire by the
 * Chords section, and its size is the loaded song index's distinct chords
 * (1,808 on the full index, ~72 KB), never anything the learner does.
 */
const CATALOG_REASON =
  "one loaded song index's catalog, read entire — its distinct chords (1,808 on the full index), built once per index";

/** Why a scope's modes are loaded whole. */
const MODES_REASON = "a subset of Hookpad's key modes — seven at most";

/** One listed chord, the share of its section's windows holding it (0…1), and what it reads as there ("V/V", "I/3", "Neapolitan"). */
export const CatalogChordSchema = z.object({
  token: ChordTokenSchema,
  share: z.number().min(0).max(1),
  /** Shown under the numeral; null when the chord is just itself (I, V7). */
  reading: z.string().nullable(),
});
export type CatalogChord = z.infer<typeof CatalogChordSchema>;

/** A section's chords below `LISTED_SHARE`, as one group: set together, answered by the Rare joker. */
export const RareGroupSchema = z.object({
  /** By share, most common first. */
  tokens: wholeList(ChordTokenSchema, { reason: CATALOG_REASON }).min(1),
  /** The share of the section's windows holding at least one of them. */
  share: z.number().min(0).max(1),
});
export type RareGroup = z.infer<typeof RareGroupSchema>;

/**
 * `core` — the track's first section, always listed whole; `other` — the
 * catch-all for chords no rule holds, always folded; `section` — the rest.
 */
export const SectionKindSchema = z.enum(["core", "section", "other"]);
export type SectionKind = z.infer<typeof SectionKindSchema>;

export const CatalogSectionSchema = z.object({
  /** `<track>:<rule>`: unique across the catalog. */
  id: z.string().min(1),
  name: z.string(),
  kind: SectionKindSchema,
  /** The key modes whose windows its shares are counted in. */
  scope: wholeList(HookpadModeSchema, { reason: MODES_REASON }).min(1),
  /** Every window of those modes. */
  windows: z.number().int().min(0),
  /** The share of those windows holding at least one of its chords. */
  coverage: z.number().min(0).max(1),
  /** The listed chords, by share, most common first. */
  chords: wholeList(CatalogChordSchema, { reason: CATALOG_REASON }),
  rare: RareGroupSchema.nullable(),
});
export type CatalogSection = z.infer<typeof CatalogSectionSchema>;

export const CatalogTrackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  blurb: z.string(),
  scope: wholeList(HookpadModeSchema, { reason: MODES_REASON }).min(1),
  /** Every window of the track's modes. */
  windows: z.number().int().min(0),
  /** Core first, Other last, the rest by how many windows they cover. Empty sections are left out. */
  sections: wholeList(CatalogSectionSchema, { reason: CATALOG_REASON }),
});
export type CatalogTrack = z.infer<typeof CatalogTrackSchema>;

export const CatalogSchema = z.object({
  tracks: wholeList(CatalogTrackSchema, { reason: CATALOG_REASON }),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * The catalog as served: `not-ready` until the song index is loaded — never an
 * empty catalog, which would read as an index with no chords in it.
 */
export const CatalogStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-ready") }),
  z.object({ kind: z.literal("ready"), catalog: CatalogSchema }),
]);
export type CatalogState = z.infer<typeof CatalogStateSchema>;

// ── Building it ──────────────────────────────────────────────────────────────

/** One section while it is counted. */
type Tally = {
  rule: { id: string; name: string; kind: SectionKind };
  /** The section's own reader, tried before the track's. */
  reads: ChordReader | undefined;
  /** Its rule index in the track: the tiebreak after coverage. */
  order: number;
  scope: readonly HookpadMode[];
  windows: number;
  covered: number;
  /** Windows (in scope) holding each of its chords. */
  byToken: Map<ChordToken, number>;
};

/**
 * The catalog for these token sets (one row per distinct mode × chord set of
 * the windows, with how many windows have it).
 *
 * - Each chord lands, per key mode it occurs in, in the first section of the
 *   track whose scope holds that mode and whose rule holds the chord — else in
 *   the track's Other section. So every chord of a track's modes is placed
 *   exactly once per mode.
 * - A chord's share is the windows in its section's scope holding it, over all
 *   windows in that scope; a section's coverage, the windows holding at least
 *   one of its chords.
 * - Listed: every Core chord; any other chord with a share of at least
 *   `LISTED_SHARE` (or its track's `listedShare`); and every chord of a section
 *   with `MAX_FOLDED_RARE` or fewer below it. The rest fold into the section's rare group. Other lists
 *   nothing: a chord no rule names is always rare.
 */
export function buildCatalog(sets: readonly TokenSetCount[]): Catalog {
  return { tracks: TRACK_RULES.map((rule) => buildTrack(rule, sets)) };
}

function buildTrack(
  track: TrackRule,
  sets: readonly TokenSetCount[],
): CatalogTrack {
  const tallies: Tally[] = [
    ...track.sections.map((rule, order) => ({
      rule: {
        id: rule.id,
        name: rule.name,
        kind:
          rule.id === CORE_SECTION_ID
            ? ("core" as const)
            : ("section" as const),
      },
      reads: rule.reads,
      order,
      scope: rule.scope ?? track.scope,
      windows: 0,
      covered: 0,
      byToken: new Map<ChordToken, number>(),
    })),
    {
      rule: { id: OTHER_SECTION_ID, name: "Other", kind: "other" as const },
      reads: undefined,
      order: track.sections.length,
      scope: track.scope,
      windows: 0,
      covered: 0,
      byToken: new Map<ChordToken, number>(),
    },
  ];

  // Where each (mode, chord) goes: the first rule holding it, else Other —
  // or nowhere, for a chord the track does not admit.
  const placed = new Map<string, number | null>();
  const sectionOf = (mode: HookpadMode, token: ChordToken): number | null => {
    const key = `${mode}|${token}`;
    const known = placed.get(key);
    if (known !== undefined) return known;
    const parts = parseChordToken(token);
    let index: number | null = null;
    if (track.admits === undefined || track.admits(parts)) {
      const ruled = track.sections.findIndex(
        (rule) =>
          (rule.scope ?? track.scope).includes(mode) && rule.holds(parts),
      );
      index = ruled === -1 ? tallies.length - 1 : ruled;
    }
    placed.set(key, index);
    return index;
  };

  const inScope = sets.filter((set) => track.scope.includes(set.mode));
  for (const set of inScope) {
    for (const tally of tallies) {
      if (tally.scope.includes(set.mode)) tally.windows += set.windows;
    }
    const hit = new Set<number>();
    for (const token of new Set(set.tokens)) {
      const index = sectionOf(set.mode, token);
      if (index === null) continue;
      const tally = tallies[index];
      if (tally === undefined) throw new Error("unreachable: a placed section");
      tally.byToken.set(token, (tally.byToken.get(token) ?? 0) + set.windows);
      hit.add(index);
    }
    for (const index of hit) {
      const tally = tallies[index];
      if (tally !== undefined) tally.covered += set.windows;
    }
  }

  const sections = tallies
    .filter((tally) => tally.byToken.size > 0)
    .map((tally) => finishSection(track, tally, inScope));
  const rank = (s: CatalogSection) =>
    s.kind === "core" ? 0 : s.kind === "other" ? 2 : 1;
  const covered = (s: CatalogSection) => s.coverage * s.windows;
  const order = new Map(
    tallies.map((t) => [`${track.id}:${t.rule.id}`, t.order]),
  );
  sections.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      covered(b) - covered(a) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  return {
    id: track.id,
    name: track.name,
    blurb: track.blurb,
    scope: [...track.scope],
    windows: inScope.reduce((sum, set) => sum + set.windows, 0),
    sections,
  };
}

function finishSection(
  track: TrackRule,
  tally: Tally,
  inScope: readonly TokenSetCount[],
): CatalogSection {
  const share = (count: number) =>
    tally.windows === 0 ? 0 : count / tally.windows;
  const byShare = [...tally.byToken]
    .map(([token, count]) => ({ token, share: share(count) }))
    .sort((a, b) => b.share - a.share || compareTokens(a.token, b.token));

  let listed: Ranked[];
  let rare: Ranked[];
  switch (tally.rule.kind) {
    case "core":
      listed = byShare;
      rare = [];
      break;
    case "other":
      listed = [];
      rare = byShare;
      break;
    case "section": {
      const threshold = track.listedShare ?? LISTED_SHARE;
      const below = byShare.filter((c) => c.share < threshold);
      if (below.length <= MAX_FOLDED_RARE) {
        listed = byShare;
        rare = [];
      } else {
        listed = byShare.filter((c) => c.share >= threshold);
        rare = below;
      }
      break;
    }
  }

  let rareGroup: RareGroup | null = null;
  if (rare.length > 0) {
    const rareTokens = new Set(rare.map((c) => c.token));
    let covered = 0;
    for (const set of inScope) {
      if (!tally.scope.includes(set.mode)) continue;
      if (set.tokens.some((token) => rareTokens.has(token)))
        covered += set.windows;
    }
    rareGroup = { tokens: rare.map((c) => c.token), share: share(covered) };
  }

  return {
    id: `${track.id}:${tally.rule.id}`,
    name: tally.rule.name,
    kind: tally.rule.kind,
    scope: [...tally.scope],
    windows: tally.windows,
    coverage: share(tally.covered),
    chords: listed.map(({ token, share }) => ({
      token,
      share,
      reading: tally.reads?.(token) ?? track.reads(token),
    })),
    rare: rareGroup,
  };
}

/** A chord of a section and its share, before it is listed or folded. */
type Ranked = { token: ChordToken; share: number };

const compareTokens = (a: ChordToken, b: ChordToken) =>
  a < b ? -1 : a > b ? 1 : 0;

// ── Reading it ───────────────────────────────────────────────────────────────

/** Every chord some track lists. Anything else is answered by the Rare joker. */
export function listedTokens(catalog: Catalog): ReadonlySet<ChordToken> {
  return new Set(
    catalog.tracks.flatMap((track) =>
      track.sections.flatMap((section) => section.chords.map((c) => c.token)),
    ),
  );
}

/** Whether any track lists this chord: when it is not, the Rare joker is its right answer. */
export function isListed(catalog: Catalog, token: ChordToken): boolean {
  return catalog.tracks.some((track) =>
    track.sections.some((section) =>
      section.chords.some((c) => c.token === token),
    ),
  );
}

/** Every chord of a track, listed and rare, each once, in the track's order. */
export function trackTokens(track: CatalogTrack): ChordToken[] {
  return [
    ...new Set(
      track.sections.flatMap((section) => [
        ...section.chords.map((c) => c.token),
        ...(section.rare?.tokens ?? []),
      ]),
    ),
  ];
}

/** Every chord of a section, listed then rare. */
export function sectionTokens(section: CatalogSection): ChordToken[] {
  return [
    ...section.chords.map((c) => c.token),
    ...(section.rare?.tokens ?? []),
  ];
}

/** The listed chords in catalog order (track, then section, then share), each once: the order "Your chords" follows. */
export function catalogOrder(catalog: Catalog): ChordToken[] {
  return [
    ...new Set(
      catalog.tracks.flatMap((track) =>
        track.sections.flatMap((section) => section.chords.map((c) => c.token)),
      ),
    ),
  ];
}

/** The state a group of chords shares, or `mixed` when they differ. Throws on an empty group. */
export function groupState(
  selection: Selection,
  tokens: readonly ChordToken[],
): ChordState | "mixed" {
  const [first, ...rest] = tokens;
  if (first === undefined) throw new Error("groupState: an empty group");
  const state = chordState(selection, first);
  return rest.every((token) => chordState(selection, token) === state)
    ? state
    : "mixed";
}

/** How far the learner is into a track: its listed chords practised and heard, and its rare chords on. */
export type TrackStanding = {
  /** Any chord of the track is on. */
  started: boolean;
  practised: number;
  heard: number;
  /** Chords on that the track only holds in a rare group. */
  rare: number;
};

export function trackStanding(
  track: CatalogTrack,
  selection: Selection,
): TrackStanding {
  const listed = new Set(
    track.sections.flatMap((section) => section.chords.map((c) => c.token)),
  );
  let practised = 0;
  let heard = 0;
  let rare = 0;
  for (const token of trackTokens(track)) {
    const state = chordState(selection, token);
    if (state === "off") continue;
    if (!listed.has(token)) rare++;
    else if (state === "practice") practised++;
    else heard++;
  }
  return { started: practised + heard + rare > 0, practised, heard, rare };
}

/**
 * A hint, nothing more: in a track the learner has started, the listed chord
 * with the highest share that is still off. Null in a track not started, or
 * once every listed chord is on.
 */
export function suggestedNext(
  track: CatalogTrack,
  selection: Selection,
): ChordToken | null {
  if (!trackStanding(track, selection).started) return null;
  let best: CatalogChord | null = null;
  for (const section of track.sections) {
    for (const chord of section.chords) {
      if (chordState(selection, chord.token) !== "off") continue;
      if (best === null || chord.share > best.share) best = chord;
    }
  }
  return best?.token ?? null;
}

/**
 * Every place the catalog holds a chord: which track and section, and its
 * share there when it is listed — a rare chord's own share is not shipped,
 * only its group's.
 */
export type ChordPlace =
  | { trackId: string; sectionId: string; listed: true; share: number }
  | { trackId: string; sectionId: string; listed: false; groupShare: number };

export function chordPlaces(catalog: Catalog, token: ChordToken): ChordPlace[] {
  const places: ChordPlace[] = [];
  for (const track of catalog.tracks) {
    for (const section of track.sections) {
      const chord = section.chords.find((c) => c.token === token);
      if (chord !== undefined) {
        places.push({
          trackId: track.id,
          sectionId: section.id,
          listed: true,
          share: chord.share,
        });
      } else if (section.rare?.tokens.includes(token) === true) {
        places.push({
          trackId: track.id,
          sectionId: section.id,
          listed: false,
          groupShare: section.rare.share,
        });
      }
    }
  }
  return places;
}
