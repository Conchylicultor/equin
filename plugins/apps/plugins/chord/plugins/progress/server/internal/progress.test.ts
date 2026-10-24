/**
 * The round writer and the `chord.progress` loader against a real Postgres:
 * the last-20 window (including the order inside one round), today's cutoff in
 * several time zones, and the all-time counts.
 *
 * A throwaway database with the real schema, applied by the real migration
 * chain — so it needs the migration `./equin build` generates from
 * `tables.ts`, and the running embedded cluster. `createTestDb` throws loudly
 * rather than skipping when the cluster is not up.
 *
 * Run: `./equin test plugins/apps/plugins/chord/plugins/progress`
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { ChordToken } from "@plugins/apps/plugins/chord/plugins/song-index/core";
import type { RecordedBlanks } from "@plugins/apps/plugins/chord/plugins/curriculum/core";
import {
  MASTERY_WINDOW,
  encodeProgressParams,
  type Answer,
  type RecordRoundBody,
} from "../../core";
import { loadChordProgress } from "./progress";
import { recordRound } from "./record";
import { _chordAnswers, _chordRounds } from "./tables";

const I = "0:4-3/0" as ChordToken;
const IV = "5:4-3/0" as ChordToken;
const V = "7:4-3/0" as ChordToken;
/** Two chords the stub catalog below does not list: the Rare joker answers them. */
const rareA = "1:1-1/0" as ChordToken;
const rareB = "6:4-4/2" as ChordToken;

/** A catalog that lists every chord but `rareA` and `rareB`. */
const isListed = (token: ChordToken) =>
  Promise.resolve(token !== rareA && token !== rareB);
/** The same stub catalog as a set: what the progress loader pools against. */
const LISTED: ReadonlySet<ChordToken> = new Set([I, IV, V]);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "chord_progress_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE chord_rounds CASCADE`);
});

type Given = { token: ChordToken; answer: Answer; answerMs?: number };

/** A round checked at `at`, its answers in the order given, asked at `blanks` (none: before the setting existed). */
async function roundAt(
  at: Date,
  answers: Given[],
  blanks: RecordedBlanks | null = null,
): Promise<void> {
  const [round] = await t.db
    .insert(_chordRounds)
    .values({
      sectionId: "section",
      videoId: "video",
      shape: "bars-4",
      startBeat: 1,
      checkedAt: at,
      boxCount: answers.length,
      correctCount: answers.filter((a) => right(a)).length,
    })
    .returning({ id: _chordRounds.id });
  if (round === undefined) throw new Error("no round inserted");
  await t.db.insert(_chordAnswers).values(
    answers.map((a, position) => ({
      roundId: round.id,
      position,
      token: a.token,
      answer: a.answer,
      correct: right(a),
      answerMs: a.answerMs ?? 1000,
      answeredAt: at,
      blanks,
    })),
  );
}

/** The rule the server applies, against the stub catalog. */
const right = (a: Given) =>
  a.answer === "rare"
    ? a.token === rareA || a.token === rareB
    : a.answer === a.token;

const params = (timeZone: string, tokens: ChordToken[]) =>
  encodeProgressParams({ timeZone, tokens });

describe("recordRound", () => {
  test("writes the round and its answers, deciding right and wrong itself", async () => {
    const body: RecordRoundBody = {
      sectionId: "abc_DEF-1",
      videoId: "dQw4w9WgXcQ",
      shape: "bars-4",
      startBeat: 17.5,
      answers: [
        { position: 1, token: IV, answer: V, answerMs: 2500 },
        { position: 0, token: I, answer: I, answerMs: 800 },
        { position: 2, token: V, answer: V, answerMs: 1200 },
      ],
      givenCount: 0,
      blanks: "all",
    };
    const { roundId } = await recordRound(t.db, body, isListed);

    const [round] = await t.db
      .select()
      .from(_chordRounds)
      .where(eq(_chordRounds.id, roundId));
    if (round === undefined) throw new Error("the round was not written");
    expect(round).toMatchObject({
      sectionId: "abc_DEF-1",
      videoId: "dQw4w9WgXcQ",
      shape: "bars-4",
      startBeat: 17.5,
      boxCount: 3,
      correctCount: 2,
      givenCount: 0,
    });

    const answers = await t.db
      .select()
      .from(_chordAnswers)
      .where(eq(_chordAnswers.roundId, roundId))
      .orderBy(_chordAnswers.position);
    expect(
      answers.map((a) => [
        a.position,
        a.token,
        a.answer,
        a.correct,
        a.answerMs,
      ]),
    ).toEqual([
      [0, I, I, true, 800],
      [1, IV, V, false, 2500],
      [2, V, V, true, 1200],
    ]);
    for (const a of answers) {
      expect(a.answeredAt.getTime()).toBe(round.checkedAt.getTime());
    }
  });

  test("a scaffolded round writes only the boxes the learner named", async () => {
    // Four boxes in the loop, one asked for: the answer is written at its own
    // position, and the three shown filled in are the round's `givenCount`.
    const { roundId } = await recordRound(
      t.db,
      {
        sectionId: "abc_DEF-1",
        videoId: "dQw4w9WgXcQ",
        shape: "bars-4",
        startBeat: 1,
        answers: [{ position: 2, token: V, answer: V, answerMs: 1100 }],
        givenCount: 3,
        blanks: "random",
      },
      isListed,
    );
    const [round] = await t.db
      .select()
      .from(_chordRounds)
      .where(eq(_chordRounds.id, roundId));
    expect(round).toMatchObject({
      boxCount: 1,
      correctCount: 1,
      givenCount: 3,
    });
    const answers = await t.db
      .select()
      .from(_chordAnswers)
      .where(eq(_chordAnswers.roundId, roundId));
    expect(answers.map((a) => a.position)).toEqual([2]);
  });
});

describe("recordRound: the Rare joker", () => {
  test("is right for a chord the catalog does not list, and wrong for a listed one", async () => {
    const asked: ChordToken[] = [];
    const { roundId } = await recordRound(
      t.db,
      {
        sectionId: "abc_DEF-1",
        videoId: "dQw4w9WgXcQ",
        shape: "bars-4",
        startBeat: 1,
        answers: [
          { position: 0, token: rareA, answer: "rare", answerMs: 900 },
          { position: 1, token: I, answer: "rare", answerMs: 900 },
          { position: 2, token: rareB, answer: I, answerMs: 900 },
          { position: 3, token: V, answer: V, answerMs: 900 },
        ],
        givenCount: 0,
        blanks: "all",
      },
      (token) => {
        asked.push(token);
        return isListed(token);
      },
    );
    // The catalog is asked only about boxes answered Rare.
    expect(asked.sort()).toEqual([I, rareA].sort());
    const answers = await t.db
      .select()
      .from(_chordAnswers)
      .where(eq(_chordAnswers.roundId, roundId))
      .orderBy(_chordAnswers.position);
    expect(answers.map((a) => [a.answer, a.correct])).toEqual([
      ["rare", true],
      ["rare", false],
      [I, false],
      [V, true],
    ]);
    const [round] = await t.db
      .select()
      .from(_chordRounds)
      .where(eq(_chordRounds.id, roundId));
    expect(round?.correctCount).toBe(2);
  });
});

describe("loadChordProgress", () => {
  const now = new Date("2026-09-18T15:00:00Z");

  test("each chord is judged on its last MASTERY_WINDOW answers, most recent first", async () => {
    // I: 5 old wrong and slow answers, then 20 recent right and fast ones.
    const base = Date.parse("2026-09-01T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await roundAt(new Date(base + i * 60_000), [
        { token: I, answer: V, answerMs: 9000 },
      ]);
    }
    for (let i = 0; i < MASTERY_WINDOW; i++) {
      await roundAt(new Date(base + (10 + i) * 60_000), [
        { token: I, answer: I, answerMs: 900 },
      ]);
    }
    // V: 21 answers in ONE round (one check time): the window is positions
    // 1…20, so the wrong answer at position 0 falls out of it.
    await roundAt(new Date(base), [
      { token: V, answer: IV },
      ...Array.from({ length: 20 }, () => ({ token: V, answer: V })),
    ]);
    // IV: 19 right answers, one short of a window.
    for (let i = 0; i < 19; i++) {
      await roundAt(new Date(base + i * 1000), [{ token: IV, answer: IV }]);
    }

    const p = await loadChordProgress(
      t.db,
      params("UTC", [V, I, IV]),
      LISTED,
      now,
    );
    expect(p.chords).toMatchObject([
      {
        token: I,
        answers: 20,
        correct: 20,
        accuracy: 1,
        medianMs: 900,
        mastered: true,
      },
      {
        token: IV,
        answers: 19,
        correct: 19,
        accuracy: 1,
        medianMs: 1000,
        mastered: false,
      },
      {
        token: V,
        answers: 20,
        correct: 20,
        accuracy: 1,
        medianMs: 1000,
        mastered: true,
      },
    ]);
  });

  test("every unlisted chord stands in one pool: their last MASTERY_WINDOW answers together", async () => {
    const base = Date.parse("2026-09-01T12:00:00Z");
    // 15 old wrong answers for rareA, then 12 recent right ones for each.
    for (let i = 0; i < 15; i++) {
      await roundAt(new Date(base + i * 1000), [{ token: rareA, answer: I }]);
    }
    for (let i = 0; i < 12; i++) {
      await roundAt(new Date(base + (100 + i) * 1000), [
        { token: rareA, answer: "rare" },
        { token: rareB, answer: "rare" },
      ]);
    }
    // Newer answers for listed chords are not part of the pool.
    for (let i = 0; i < 5; i++) {
      await roundAt(new Date(base + (200 + i) * 1000), [
        { token: I, answer: V },
      ]);
    }
    // The pool does not depend on the tokens asked for.
    for (const tokens of [[I], []]) {
      const p = await loadChordProgress(
        t.db,
        params("UTC", tokens),
        LISTED,
        now,
      );
      // The 24 right ones are the newest rare answers: the window holds 20 of them.
      expect(p.rare).toMatchObject({
        answers: MASTERY_WINDOW,
        correct: MASTERY_WINDOW,
        accuracy: 1,
        mastered: true,
      });
    }
    // A catalog that lists rareA too: only rareB's 12 right answers are rare.
    const wider = await loadChordProgress(
      t.db,
      params("UTC", [I]),
      new Set([...LISTED, rareA]),
      now,
    );
    expect(wider.rare).toMatchObject({ answers: 12, correct: 12 });
  });

  test("no rare chord ever answered: the pool is null", async () => {
    await roundAt(new Date("2026-09-18T10:00:00Z"), [{ token: I, answer: I }]);
    const p = await loadChordProgress(t.db, params("UTC", [I]), LISTED, now);
    expect(p.rare).toBeNull();
  });

  test("a chord never answered has an empty standing, and the empty set is fine", async () => {
    await roundAt(new Date("2026-09-18T10:00:00Z"), [{ token: I, answer: I }]);
    const p = await loadChordProgress(t.db, params("UTC", [V]), LISTED, now);
    expect(p.chords).toMatchObject([
      {
        token: V,
        answers: 0,
        correct: 0,
        accuracy: null,
        medianMs: null,
        mastered: false,
      },
    ]);
    const none = await loadChordProgress(t.db, params("UTC", []), LISTED, now);
    expect(none.chords).toEqual([]);
    expect(none.allTime).toEqual({ songs: 1, answers: 1, correct: 1 });
  });

  test("today starts at local midnight in the requested time zone", async () => {
    // now = 2026-09-18 15:00 UTC = 11:00 EDT = 00:00 (the 19th) in Tokyo.
    await roundAt(new Date("2026-09-17T23:59:00Z"), [
      { token: I, answer: I, answerMs: 1000 },
    ]);
    await roundAt(new Date("2026-09-18T03:59:00Z"), [
      { token: I, answer: V, answerMs: 2000 },
      { token: V, answer: V, answerMs: 3000 },
    ]);
    await roundAt(new Date("2026-09-18T04:00:00Z"), [
      { token: IV, answer: IV, answerMs: 4000 },
    ]);
    await roundAt(new Date("2026-09-18T14:59:59Z"), [
      { token: V, answer: I, answerMs: 5000 },
    ]);

    // UTC: midnight 00:00Z — the last three rounds.
    const utc = await loadChordProgress(t.db, params("UTC", [I]), LISTED, now);
    expect(utc.today).toEqual({
      songs: 3,
      answers: 4,
      correct: 2,
      totalMs: 2000 + 3000 + 4000 + 5000,
    });

    // New York (EDT): midnight 04:00Z — the round at 04:00Z counts, 03:59Z does not.
    const ny = await loadChordProgress(
      t.db,
      params("America/New_York", [I]),
      LISTED,
      now,
    );
    expect(ny.today).toEqual({
      songs: 2,
      answers: 2,
      correct: 1,
      totalMs: 4000 + 5000,
    });

    // Tokyo: it is 00:00 on the 19th there — nothing yet today.
    const tokyo = await loadChordProgress(
      t.db,
      params("Asia/Tokyo", [I]),
      LISTED,
      now,
    );
    expect(tokyo.today).toEqual({
      songs: 0,
      answers: 0,
      correct: 0,
      totalMs: 0,
    });

    // All time ignores the zone.
    for (const p of [utc, ny, tokyo]) {
      expect(p.allTime).toEqual({ songs: 4, answers: 5, correct: 3 });
    }
  });

  test("today across a clock change: New York on the day clocks fall back", async () => {
    // 2026-11-01: midnight is still EDT (04:00Z); the day is 25 hours long.
    const fallBack = new Date("2026-11-02T04:30:00Z"); // 23:30 EST on the 1st
    await roundAt(new Date("2026-11-01T03:59:00Z"), [{ token: I, answer: I }]);
    await roundAt(new Date("2026-11-01T04:00:00Z"), [{ token: I, answer: I }]);
    await roundAt(new Date("2026-11-02T04:29:00Z"), [{ token: I, answer: I }]);
    const p = await loadChordProgress(
      t.db,
      params("America/New_York", [I]),
      LISTED,
      fallBack,
    );
    expect(p.today.songs).toBe(2);
    expect(p.allTime.songs).toBe(3);
  });

  test("params the codec refuses throw", async () => {
    expect(
      (
        await rejection(
          loadChordProgress(
            t.db,
            { timeZone: "Not/AZone", tokens: "" },
            LISTED,
            now,
          ),
        )
      ).message,
    ).toMatch(/not a time zone/);
    expect(
      (
        await rejection(
          loadChordProgress(
            t.db,
            { timeZone: "UTC", tokens: "7:4-3/0,0:4-3/0" },
            LISTED,
            now,
          ),
        )
      ).message,
    ).toMatch(/canonical/);
  });
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved instead.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
 * is flagged by await-thenable.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
