/**
 * The two loop reads, and the skip summary's shape, against a real Postgres.
 *
 * What only a database can show: that `next-chords` and `find` agree — every
 * window `next-chords` credits a chord with is a window `find` returns once
 * that chord is unlocked — and that a jsonb column keeps a list's order while
 * it re-orders an object's keys.
 *
 * The agreement is over the windows (`findLoopsWhere`). `find` also leaves out
 * videos known to be unplayable (`playableVideoWhere`), which the count
 * deliberately does not — see `nextChordsQuery` — so that part is not compared.
 *
 * Requires the running embedded cluster (`./singularity build` first);
 * `createTestDb` throws loudly rather than skipping when it is not up.
 *
 * Run: `./singularity test plugins/apps/plugins/chord`
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import type { HookpadMode } from "@plugins/integrations/plugins/hooktheory/core";
import {
  NextChordCountSchema,
  SkipTally,
  chordTokenFromParts,
  windowsInModes,
  type ChordToken,
  type LoopExtras,
  type TokenSetCount,
} from "../../core";
import {
  FindLoopsBodySchema,
  NextChordsBodySchema,
} from "../../core/endpoints";
import { SkipSummarySchema } from "../../core/skip-tally";
import {
  findLoopsWhere,
  loopsInSetQuery,
  nextChordsQuery,
  tokenSetsQuery,
} from "./find";
import { _chordLoopWindows } from "./tables";

let t: TestDb;

const major = (root: number): ChordToken =>
  chordTokenFromParts({ root, intervals: [4, 3], inversion: 0 });
const minor = (root: number): ChordToken =>
  chordTokenFromParts({ root, intervals: [3, 4], inversion: 0 });
const I = major(0);
const IV = major(5);
const V = major(7);
const vi = minor(9);
const ii = minor(2);

/** A window of `tokens` in its own section, so each row stands alone. */
function window(
  sectionId: string,
  tokens: ChordToken[],
  keyMode: HookpadMode = "major",
) {
  return {
    sectionId,
    shape: "phrase" as const,
    startBeat: 1,
    endBeat: 17,
    bars: 4,
    beatsPerBar: 4,
    beatUnit: 4,
    keyTonic: "C",
    keyMode,
    chordTokens: tokens,
    features: [],
    chordCount: tokens.length,
    changeCount: tokens.length - 1,
    hasRest: false,
    startsOnChange: true,
    rich: false,
  };
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "chord_loops_test" });
  // The windows table alone: these reads never join the sections, and the
  // throwaway database runs no migrations. The columns mirror `tables.ts` — a
  // read that grew a column it does not declare fails here, loudly.
  await t.db.execute(sql`
    CREATE TABLE chord_loop_windows (
      section_id text NOT NULL,
      shape text NOT NULL,
      start_beat double precision NOT NULL,
      end_beat double precision NOT NULL,
      bars integer NOT NULL,
      beats_per_bar double precision NOT NULL,
      beat_unit double precision NOT NULL,
      key_tonic text NOT NULL,
      key_mode text NOT NULL,
      chord_tokens text[] NOT NULL,
      features text[] NOT NULL,
      chord_count integer NOT NULL,
      change_count integer NOT NULL,
      has_rest boolean NOT NULL,
      starts_on_change boolean NOT NULL,
      rich boolean NOT NULL,
      PRIMARY KEY (section_id, shape, start_beat)
    )
  `);
  await t.db.insert(_chordLoopWindows).values([
    // A four-bar vamp on vi: nothing it plays is unlocked, and unlocking vi
    // alone makes it playable. The window the old count could not see.
    window("vamp-on-vi", [vi]),
    // The shape the old count did see: unlocked chords plus one outside.
    window("mixed", [I, IV, V, vi]),
    // Two chords short: unlocking either one alone changes nothing.
    window("two-foreign", [I, vi, ii]),
    // Already playable: it adds nothing to any chord's count.
    window("all-unlocked", [I, IV, V]),
    // The same step, in a minor key: `ii` opens one window there and none in
    // major, so a count that did not split by mode would hide it.
    window("minor-ii", [I, IV, ii], "minor"),
    // A minor-key window made only of chords the major learner already has:
    // it counts for the set, but only when minor is one of the modes asked for.
    window("minor-playable", [I, V], "minor"),
  ]);
});

afterAll(async () => {
  await t?.drop();
});

async function nextChords(unlocked: ChordToken[], modes?: HookpadMode[]) {
  const body = NextChordsBodySchema.parse({ unlocked, modes });
  const res = await t.db.execute(nextChordsQuery(body));
  return res.rows.map((row) => NextChordCountSchema.parse(row));
}

async function countInSet(unlocked: ChordToken[], modes?: HookpadMode[]) {
  const res = await t.db.execute<{ windows: number }>(
    loopsInSetQuery({ unlocked, modes }),
  );
  return res.rows[0]?.windows;
}

async function findSectionIds(
  playable: ChordToken[],
  practised: ChordToken[],
  extras: LoopExtras = 0,
) {
  const body = FindLoopsBodySchema.parse({
    playable,
    practised,
    extras,
    limit: 50,
  });
  const res = await t.db.execute<{ section_id: string }>(
    sql`SELECT section_id FROM ${_chordLoopWindows} WHERE ${findLoopsWhere(body)} ORDER BY 1`,
  );
  return res.rows.map((row) => row.section_id);
}

describe("countLoopsByNextChord's query", () => {
  test("counts a window that shares NO chord with the unlocked set", async () => {
    // The whole finding: a four-bar vamp on one chord outside the set has
    // exactly one distinct foreign chord, so unlocking that chord adds it.
    // Prefiltering on `chord_tokens && unlocked` dropped it.
    expect(await nextChords([I, IV, V])).toEqual([
      { token: vi, byMode: { major: 2 } },
      { token: ii, byMode: { minor: 1 } },
    ]);
  });

  test("ignores a window two chords short, and one already playable", async () => {
    // `two-foreign` (I, vi, ii) needs two chords, so it credits neither: `vi`
    // is counted for the vamp and `mixed` only.
    expect(await nextChords([I, IV, V])).toContainEqual({
      token: vi,
      byMode: { major: 2 },
    });
    // Unlock `ii` as well and that same window now needs only `vi` — while
    // `mixed`, which also wants IV, drops out. Two windows either way, but
    // different ones.
    expect(await nextChords([I, V, ii])).toEqual([
      { token: vi, byMode: { major: 2 } },
      { token: IV, byMode: { major: 1, minor: 1 } },
    ]);
  });

  test("every counted window is one find returns once that chord is unlocked", async () => {
    // The contract the count promises, checked against the other read: the two
    // windows credited to `vi` are exactly the ones find hands back.
    const [credited] = await nextChords([I, IV, V]);
    expect(credited).toEqual({ token: vi, byMode: { major: 2 } });
    const found = await findSectionIds([I, IV, V, vi], [vi]);
    expect(found).toEqual(["mixed", "vamp-on-vi"]);
  });

  test("splits a chord's windows by the key mode they sound in", async () => {
    // The reason for the split: `vi` opens two major windows and no minor one,
    // `ii` one minor window and no major one. A single total over both modes
    // would make `ii` look like a step for a learner who only plays major.
    const counted = await nextChords([I, IV, V]);
    const byToken = new Map(counted.map((c) => [c.token, c]));
    const viRow = byToken.get(vi);
    const iiRow = byToken.get(ii);
    if (viRow === undefined || iiRow === undefined) {
      throw new Error(
        `vi and ii must both be counted: ${JSON.stringify(counted)}`,
      );
    }
    expect(windowsInModes(viRow, ["major"])).toBe(2);
    expect(windowsInModes(viRow, ["minor"])).toBe(0);
    expect(windowsInModes(iiRow, ["major"])).toBe(0);
    expect(windowsInModes(iiRow, ["major", "minor"])).toBe(1);
  });

  test("narrowing the scan to one mode leaves the other mode's rows out", async () => {
    // `modes` still filters which windows are scanned — the counts just always
    // come back split.
    expect(await nextChords([I, IV, V], ["major"])).toEqual([
      { token: vi, byMode: { major: 2 } },
    ]);
  });
});

describe("find's extras", () => {
  test("a window must hold a practised chord, its other chords playable or up to `extras` outside", async () => {
    // Playing I, IV, V with only V practised: `vamp-on-vi` holds no practised
    // chord, so no extras setting ever offers it.
    const playable = [I, IV, V];
    expect(await findSectionIds(playable, [V])).toEqual([
      "all-unlocked",
      "minor-playable",
    ]);
    // One chord outside: `mixed` (vi) joins; `two-foreign` holds no V.
    expect(await findSectionIds(playable, [V], 1)).toEqual([
      "all-unlocked",
      "minor-playable",
      "mixed",
    ]);
    // Practising I too: `minor-ii` (ii outside) and `two-foreign` (vi, ii) open
    // at 1 and 2 extras respectively.
    expect(await findSectionIds(playable, [I, V], 1)).toEqual([
      "all-unlocked",
      "minor-ii",
      "minor-playable",
      "mixed",
    ]);
    expect(await findSectionIds(playable, [I, V], 2)).toEqual([
      "all-unlocked",
      "minor-ii",
      "minor-playable",
      "mixed",
      "two-foreign",
    ]);
    expect(await findSectionIds([I], [I], "any")).toEqual([
      "all-unlocked",
      "minor-ii",
      "minor-playable",
      "mixed",
      "two-foreign",
    ]);
  });
});

describe("countTokenSets' query", () => {
  test("one row per (mode, chord set), counting its windows", async () => {
    const res = await t.db.execute<TokenSetCount>(
      tokenSetsQuery({ shape: "phrase" }),
    );
    const total = res.rows.reduce((sum, row) => sum + row.windows, 0);
    expect(res.rows).toHaveLength(6);
    expect(total).toBe(6);
    expect(res.rows).toContainEqual({
      mode: "minor",
      tokens: [I, V],
      windows: 1,
    });
  });
});

describe("countLoopsInSet's query", () => {
  test("counts the windows made only of chords in the set", async () => {
    // `all-unlocked` (major) and `minor-playable` (minor) are the two windows
    // a learner holding I, IV and V can be given.
    expect(await countInSet([I, IV, V])).toBe(2);
    expect(await countInSet([I, IV, V], ["major"])).toBe(1);
    expect(await countInSet([I, IV, V], ["minor"])).toBe(1);
  });

  test("a window with one chord outside the set is not counted", async () => {
    // `mixed` (I, IV, V, vi) is one chord short for {I, IV, V} and counts only
    // once vi joins the set — the same rule `find` selects on, so what the
    // count promises is exactly what can be played.
    expect(await countInSet([I, IV, V])).toBe(2);
    expect(await countInSet([I, IV, V, vi])).toBe(4);
    // `two-foreign` (I, vi, ii) still needs `ii`.
    expect(await countInSet([I, IV, V, vi, ii])).toBe(6);
  });

  test("an empty set is a programming error, not zero windows", async () => {
    expect(() => loopsInSetQuery({ unlocked: [] })).toThrow(
      /empty playable set/,
    );
  });
});

describe("the skip summary in a jsonb column", () => {
  test("keeps its order as a list, where an object's keys are re-sorted", async () => {
    // Names of one length, the common one LAST alphabetically: ranked by count
    // the order is zzz, aaa — the opposite of the order jsonb gives an object.
    const tally = new SkipTally();
    tally.add("aaa", "a", "one");
    for (let i = 0; i < 3; i++) tally.add("zzz", `b${i}`, "many");
    const summary = tally.summary();
    expect(summary.map((entry) => entry.reason)).toEqual(["zzz", "aaa"]);

    const stored = await t.db.execute<{
      skipped: unknown;
      object: unknown;
    }>(sql`
      SELECT ${JSON.stringify(summary)}::jsonb AS skipped,
             ${JSON.stringify({ zzz: 3, aaa: 1 })}::jsonb AS object
    `);
    const row = stored.rows[0];
    if (row === undefined) throw new Error("no row");

    // The list comes back ranked, largest first — what `summary()` promises.
    expect(SkipSummarySchema.parse(row.skipped)).toEqual(summary);
    // And why it cannot be an object: jsonb stores an object's keys in its own
    // order (by length, then bytewise), so the ranking would come back wrong.
    expect(Object.keys(row.object as Record<string, number>)).toEqual([
      "aaa",
      "zzz",
    ]);
  });
});
