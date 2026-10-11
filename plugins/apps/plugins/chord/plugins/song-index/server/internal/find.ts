import { z } from "zod";
import {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  desc,
  eq,
  inArray,
  isNull,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  HookpadModeSchema,
  type HookpadMode,
} from "@plugins/integrations/plugins/hooktheory/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  UNPLAYABLE_STATUSES,
  type VideoStatus,
} from "@plugins/apps/plugins/chord/plugins/video-availability/core";
import {
  chordVideoStatus,
  ensureVideoStatus,
} from "@plugins/apps/plugins/chord/plugins/video-availability/server";
import {
  ChordTokenSchema,
  DEFAULT_LOOP_SHAPE,
  LoopWindowFieldsSchema,
  NextChordCountSchema,
  chordOverlapsWindow,
  expandChord,
  type ChordToken,
  type FindLoopsBody,
  type LoopCandidate,
  type LoopExtras,
  type LoopShapeId,
  type NextChordCount,
  type NextChordsBody,
  type StoredChord,
  type TokenSetCount,
  type TokenizedChord,
} from "../../core";
import { _chordLoopWindows, _chordSections } from "./tables";

// ── The reads over the loop windows ──────────────────────────────────────────
//
// `find` hands the trainer loops to play; the two counts rank what to unlock
// next. Each takes the unlocked set as an array parameter and lets the GIN
// index on `chord_tokens` do the selective part. None checks readiness: the
// handlers answer `not-ready` before calling them, and a curriculum calling
// the counts in process does the same.

const w = _chordLoopWindows;
const s = _chordSections;

/**
 * The one rule for "a window this learner can be given": a window of the shape,
 * in one of the modes (when named), whose chords are playable — or, with
 * `extras`, all but at most that many — and, when named, holding a practised
 * chord and the focus chord. `find` and `countLoopsInSet` both go through it,
 * so the two can never disagree about which windows are playable.
 *
 * The GIN-indexed tests lead: `@>` on the focus, `&&` on the practised chords,
 * `<@` on the playable set (extras `0`). Extras `1` and `2` count the chords
 * outside the playable set per row instead — an array subtraction over the ≤ 4
 * distinct tokens of a window, like `nextChordsQuery`; `any` drops the test.
 */
export function unlockedWindowsWhere(args: {
  shape: LoopShapeId;
  /** The chords a window may hold. */
  playable: readonly ChordToken[];
  /** How many chords outside `playable` a window may hold besides. Absent = 0. */
  extras?: LoopExtras;
  /** Keep only windows holding at least one of these. */
  practised?: readonly ChordToken[];
  /** Keep only windows holding this chord. */
  focus?: ChordToken;
  modes?: readonly HookpadMode[];
}): SQL {
  if (args.playable.length === 0) {
    throw new Error(
      "an empty playable set matches no window: nothing has been turned on yet",
    );
  }
  if (args.practised !== undefined && args.practised.length === 0) {
    throw new Error(
      "an empty practised set matches no window: a window must hold a practised chord",
    );
  }
  const conditions: SQL[] = [eq(w.shape, args.shape)];
  // Selective: the windows holding the focus, straight off the GIN index.
  if (args.focus !== undefined)
    conditions.push(arrayContains(w.chordTokens, [args.focus]));
  if (args.practised !== undefined)
    conditions.push(arrayOverlaps(w.chordTokens, [...args.practised]));
  const extras = args.extras ?? 0;
  if (extras === 0) {
    // Every chord of the window is playable.
    conditions.push(arrayContained(w.chordTokens, [...args.playable]));
  } else if (extras !== "any") {
    const playable = sql`${sql.param([...args.playable])}::text[]`;
    conditions.push(
      sql`cardinality(array(SELECT t FROM unnest(${w.chordTokens}) AS t WHERE NOT (t = ANY(${playable})))) <= ${extras}`,
    );
  }
  if (args.modes) conditions.push(inArray(w.keyMode, [...args.modes]));
  const where = and(...conditions);
  if (where === undefined)
    throw new Error("unreachable: unlockedWindowsWhere always has conditions");
  return where;
}

/**
 * The WHERE of `findLoopWindows` over the windows, built apart so its SQL can
 * be checked without a database. The video's condition is `playableVideoWhere`,
 * kept out of this one because it needs the sections and the video status
 * joined: this one stands on the windows table alone.
 */
export function findLoopsWhere(body: FindLoopsBody): SQL {
  const conditions: SQL[] = [
    unlockedWindowsWhere({
      shape: body.shape,
      playable: body.playable,
      extras: body.extras,
      practised: body.practised,
      focus: body.focus,
    }),
  ];
  if (body.requireFeatures)
    conditions.push(arrayContains(w.features, body.requireFeatures));
  if (body.forbidFeatures)
    conditions.push(not(arrayOverlaps(w.features, body.forbidFeatures)));
  if (body.excludeSectionIds)
    conditions.push(notInArray(w.sectionId, body.excludeSectionIds));
  const where = and(...conditions);
  if (where === undefined)
    throw new Error("unreachable: findLoopsWhere always has conditions");
  return where;
}

/**
 * The video's part of `findLoopWindows`' WHERE: leave out a video already known
 * to be unplayable.
 *
 * **Left join, fail open.** A video nobody has looked at has no status row, and
 * it is offered: that is the point — `findLoopWindows` checks it on demand a
 * moment later, and an unreachable YouTube must never empty the trainer. Only a
 * status that says the video cannot play removes it here.
 */
export function playableVideoWhere(): SQL {
  const where = or(
    isNull(chordVideoStatus.status),
    notInArray(chordVideoStatus.status, [...UNPLAYABLE_STATUSES]),
  );
  if (where === undefined)
    throw new Error("unreachable: playableVideoWhere always has conditions");
  return where;
}

const isPlayable = (status: VideoStatus): boolean =>
  !UNPLAYABLE_STATUSES.some((unplayable) => unplayable === status);

/**
 * Rows the query fetches per candidate asked for. About 1 video in 6 in the
 * dump cannot play (measured on 720 ids, 2026-09-17/18), and on a cold index
 * the query cannot know which: the check runs after it. Three times the limit
 * still leaves `limit` survivors when two in three turn out dead — four times
 * the measured rate.
 */
const CANDIDATE_OVERFETCH = 3;

/**
 * The section's chords the window sounds, in beat order.
 *
 * The overlap rule is `chordOverlapsWindow`, the same call the window's
 * `chordTokens` and `chordCount` were derived from: a chord returned here is
 * one the window counted, so the payload can never carry a token outside the
 * window's `chord_tokens` — the array the "every chord is unlocked" filter runs
 * against.
 */
export function chordsInWindow(
  chords: readonly StoredChord[],
  window: { startBeat: number; endBeat: number },
): TokenizedChord[] {
  return chords
    .filter((c) => chordOverlapsWindow(c, window.startBeat, window.endBeat))
    .sort((a, b) => a.beat - b.beat)
    .map(expandChord);
}

/**
 * Random windows holding a practised chord, whose other chords are playable
 * (up to `extras` of them need not be), with what the trainer needs to play them — on a video not known to be unplayable.
 *
 * Three steps: the query leaves out the videos already known dead and fetches
 * `limit * CANDIDATE_OVERFETCH` rows; one wave of checks (`ensureVideoStatus`)
 * settles the videos nobody has looked at recently; the ones that just came
 * back dead are dropped, and at most `limit` survivors are returned.
 *
 * **Fewer than `limit` is a legal answer**, and there is deliberately no second
 * query to top it up: `limit` has always meant "at most", the trainer asks for
 * a small batch often, and a retry loop would put a chain of oEmbed waves in
 * front of a read that has to answer in tens of milliseconds.
 */
export async function findLoopWindows(
  body: FindLoopsBody,
): Promise<LoopCandidate[]> {
  const rows = await db
    // Named columns, not the two whole rows: a section also carries `keys`,
    // `meters` and `tempos`, three jsonb columns a candidate never shows, and
    // selecting the row would decode all three per row for nothing.
    .select({
      sectionId: s.id,
      artist: s.artist,
      song: s.song,
      sectionName: s.sectionName,
      videoId: s.videoId,
      videoDurationSeconds: s.videoDurationSeconds,
      alignment: s.alignment,
      chords: s.chords,
      window: {
        shape: w.shape,
        startBeat: w.startBeat,
        endBeat: w.endBeat,
        bars: w.bars,
        beatsPerBar: w.beatsPerBar,
        beatUnit: w.beatUnit,
        keyTonic: w.keyTonic,
        keyMode: w.keyMode,
        chordTokens: w.chordTokens,
        features: w.features,
        chordCount: w.chordCount,
        changeCount: w.changeCount,
        hasRest: w.hasRest,
        startsOnChange: w.startsOnChange,
        rich: w.rich,
      },
    })
    .from(w)
    .innerJoin(s, eq(s.id, w.sectionId))
    // Joined to filter only. The status a candidate carries comes from the
    // check wave below, which is never staler than this row.
    .leftJoin(chordVideoStatus, eq(chordVideoStatus.videoId, s.videoId))
    .where(and(findLoopsWhere(body), playableVideoWhere()))
    // Rich windows first (`isRichLoop`: a real progression, not a back-and-
    // forth), a random pick within each — sorted after the GIN index has cut
    // them down, never a sort of the table. Measured 2026-09-17 on the full
    // index (183,270 windows), 100 random unlocked sets over HTTP: p95 31 ms,
    // inside the < 50 ms target, so the sort stays. A learner whose chords
    // make no rich window still gets the others.
    .orderBy(desc(w.rich), sql`random()`)
    .limit(body.limit * CANDIDATE_OVERFETCH);

  const candidates = rows.map(({ window, chords, ...section }) => {
    if (section.videoId === null) {
      throw new Error(
        `section ${section.sectionId} has loop windows but no video — a load wrote windows for an unloopable section`,
      );
    }
    return {
      ...section,
      videoId: section.videoId,
      // The token and feature arrays are plain `text[]` columns: parsed here into
      // their branded and enumerated types rather than asserted.
      window: LoopWindowFieldsSchema.parse(window),
      chords: chordsInWindow(chords, window),
    };
  });

  // One wave over every fetched video, never a loop: a failed or timed-out
  // check comes back `unknown`, which keeps the candidate.
  const statuses = await ensureVideoStatus([
    ...new Set(candidates.map((c) => c.videoId)),
  ]);
  const playable: LoopCandidate[] = [];
  for (const candidate of candidates) {
    const videoStatus = statuses.get(candidate.videoId);
    if (videoStatus === undefined) {
      throw new Error(
        `ensureVideoStatus returned no status for video ${candidate.videoId}, one of the ids it was given`,
      );
    }
    if (!isPlayable(videoStatus)) continue;
    playable.push({ ...candidate, videoStatus });
    if (playable.length === body.limit) break;
  }
  return playable;
}

/**
 * The query behind `countLoopsByNextChord`: for every window of the shape (and
 * modes), its distinct chords outside the unlocked set; a window with exactly
 * one counts for that chord.
 *
 * **It counts windows on dead videos too, deliberately.** `find` leaves out a
 * video known to be unplayable; this does not, so the two disagree by the
 * windows on those videos. The number only RANKS chords ("which one next"), and
 * the ~17 % of windows on dead videos falls roughly evenly across chords, so the
 * ranking barely moves. With videos checked on demand, most are `unknown`
 * anyway: the filter would remove almost nothing, for a join to the sections and
 * the video status over the 183k windows. If this count ever becomes a promise
 * the user reads ("unlock vi for 1,542 songs"), it needs that join AND a swept
 * corpus, so the statuses it filters on are known — one change, not this one.
 *
 * **Every window of the shape, with no overlap prefilter.** A window that
 * shares nothing with the unlocked set still counts when it has one distinct
 * token — a four-bar vamp on a single chord — and unlocking that chord really
 * does make `findLoopsWhere` return it, which is what this count promises.
 * Filtering on `chord_tokens && unlocked` first (the GIN index's selective
 * shape) dropped exactly those windows, and there are many: on the full index,
 * a learner who knows only I was told IV adds 2,121 windows (really 2,313) and
 * was never shown the minor tonic at all, though a vamp on it adds 1,542.
 *
 * So this scans the windows of the shape, and that is what it costs: measured
 * on the full index (183,270 windows), median of 6 runs, 87 ms for one unlocked
 * chord and 119 ms for eight — against 36 ms and 101 ms for the prefiltered
 * query that answered wrongly. The per-row work is one array subtraction over
 * the ≤ 4 distinct tokens of a 4-bar window. Adding `NOT (chord_tokens <@
 * unlocked)` to skip the windows that are already playable was measured too,
 * and is slower (94 / 125 ms): the test costs more than the rows it saves.
 */
export function nextChordsQuery(body: NextChordsBody): SQL {
  const unlocked = sql`${sql.param(body.unlocked)}::text[]`;
  const modes = body.modes ? sql`AND ${inArray(w.keyMode, body.modes)}` : sql``;
  return sql`
    SELECT token, jsonb_object_agg(key_mode, windows) AS "byMode"
    FROM (
      SELECT foreign_tokens[1] AS token, key_mode, count(*)::int AS windows
      FROM (
        SELECT
          array(
            SELECT t FROM unnest(${w.chordTokens}) AS t WHERE NOT (t = ANY(${unlocked}))
          ) AS foreign_tokens,
          ${w.keyMode} AS key_mode
        FROM ${w}
        WHERE ${w.shape} = ${body.shape}
          ${modes}
      ) AS candidates
      WHERE cardinality(foreign_tokens) = 1
      GROUP BY 1, 2
    ) AS per_mode
    GROUP BY token
    ORDER BY max(windows) DESC, token
    LIMIT ${body.limit}
  `;
}

/**
 * The chords worth unlocking next, by how many windows each would add — split
 * by the window's key mode, so a caller that only plays some modes (a
 * curriculum working through minor keys) sums the ones it means. The chord with
 * the largest single-mode count comes first; `limit` counts chords, not rows.
 */
export async function countLoopsByNextChord(
  body: NextChordsBody,
): Promise<NextChordCount[]> {
  return executeRows(db, {
    query: nextChordsQuery(body),
    row: NextChordCountSchema,
  });
}

const LoopSetCountSchema = z.object({ windows: z.number().int() });

/** What `countLoopsInSet` asks for: a chord set, and optionally the modes and shape. */
export type LoopSetCountArgs = {
  unlocked: readonly ChordToken[];
  modes?: readonly HookpadMode[];
  shape?: LoopShapeId;
};

/**
 * The query behind `countLoopsInSet`, built apart so a database test can run it
 * on a throwaway. It selects on `unlockedWindowsWhere` — the same rule `find`
 * uses — with no practised chord and no extras, so a window counts only when every chord in it is in
 * the set: one chord outside and it is not this learner's yet.
 */
export function loopsInSetQuery(args: LoopSetCountArgs): SQL {
  return sql`
    SELECT count(*)::int AS windows
    FROM ${w}
    WHERE ${unlockedWindowsWhere({
      shape: args.shape ?? DEFAULT_LOOP_SHAPE,
      playable: args.unlocked,
      modes: args.modes,
    })}
  `;
}

/**
 * How many windows are made only of chords in this set: what a learner holding
 * exactly these chords could be given — the number behind "how many songs would
 * this family's seed open".
 *
 * Like `nextChordsQuery` it ignores the videos, and for the same reason: it
 * ranks a step rather than promising the learner a number.
 */
export async function countLoopsInSet(args: LoopSetCountArgs): Promise<number> {
  const rows = await executeRows(db, {
    query: loopsInSetQuery(args),
    row: LoopSetCountSchema,
  });
  const row = rows[0];
  if (row === undefined) throw new Error("count(*) returned no row");
  return row.windows;
}

const TokenSetCountRowSchema = z.object({
  mode: HookpadModeSchema,
  tokens: z.array(ChordTokenSchema),
  windows: z.number().int().min(1),
});

/** The query behind `countTokenSets`, built apart so a database test can run it. */
export function tokenSetsQuery(args: { shape: LoopShapeId }): SQL {
  return sql`
    SELECT ${w.keyMode} AS mode, ${w.chordTokens} AS tokens, count(*)::int AS windows
    FROM ${w}
    WHERE ${w.shape} = ${args.shape}
    GROUP BY 1, 2
  `;
}

/**
 * Every distinct (key mode, chord set) of the windows of a shape, with how
 * many windows have it: the whole index folded to what a chord catalog needs
 * — which chords occur, in which modes, and together — in one scan (on the
 * full index, 83,752 rows over 183,270 windows).
 *
 * Like the other counts it ignores the videos, and it does not check
 * readiness: gate it on `loadIndexStatus()`, since before the load it answers
 * no rows, which would read as an index with no chords.
 */
export async function countTokenSets(args: {
  shape: LoopShapeId;
}): Promise<TokenSetCount[]> {
  return executeRows(db, {
    label: "chord.song-index token sets",
    query: tokenSetsQuery(args),
    row: TokenSetCountRowSchema,
  });
}
