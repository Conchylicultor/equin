import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import {
  ChordTokenSchema,
  type ChordToken,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";

// ── The live stats: `chord.progress` ─────────────────────────────────────────

const count = z.number().int().min(0);

/** How a chord — or a pool of chords — stands over its last `MASTERY_WINDOW` answers (`chordMastery`). */
export const MasteryStandingSchema = z.object({
  /** Answers in the window: at most `MASTERY_WINDOW`. */
  answers: count,
  correct: count,
  accuracy: z.number().nullable(),
  medianMs: z.number().nullable(),
  mastered: z.boolean(),
});
export type MasteryStanding = z.infer<typeof MasteryStandingSchema>;

/** One chord, over its last `MASTERY_WINDOW` answers. */
export const ChordStandingSchema = MasteryStandingSchema.extend({
  token: ChordTokenSchema,
});
export type ChordStanding = z.infer<typeof ChordStandingSchema>;

export const ChordProgressSchema = z.object({
  /** One per requested token, in the params' (canonical, sorted) order. */
  chords: wholeList(ChordStandingSchema, {
    reason: "one entry per requested token — the params bound it",
  }),
  /**
   * Every chord the catalog does not list — the chords the Rare joker
   * answers — as one pool, over the last `MASTERY_WINDOW` answers given for
   * any of them. The server decides which chords are rare (its catalog), so
   * the pool does not depend on what the learner has on. Null when no rare
   * chord was ever answered.
   */
  rare: MasteryStandingSchema.nullable(),
  /** Since local midnight in the params' time zone. `songs` counts checked rounds. */
  today: z.object({
    songs: count,
    answers: count,
    correct: count,
    /** The sum of today's answer times. */
    totalMs: z.number().min(0),
  }),
  allTime: z.object({ songs: count, answers: count, correct: count }),
});
export type ChordProgress = z.infer<typeof ChordProgressSchema>;

/**
 * The resource's params, on the wire. Build them with `encodeProgressParams`
 * only: `tokens` is a chord set sorted, deduplicated and joined by commas, so
 * one set is one subscription, and the server refuses any other spelling.
 *
 * The trainer asks for EVERY listed chord of the catalog, not for the chords
 * the learner has on: the subscription then depends only on the catalog, so
 * toggling a chord never re-keys it (no pending read, no flash).
 */
export type ChordProgressParams = {
  timeZone: string;
  tokens: string;
};

/** What the params say. */
export type DecodedProgressParams = {
  /** An IANA zone (`Europe/Paris`): where "today" starts. */
  timeZone: string;
  /** The chords to stand one by one. */
  tokens: ChordToken[];
};

/** Throws on a string that is not a time zone `Intl` knows. */
function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new Error(
        `"${timeZone}" is not a time zone (expected an IANA name, e.g. "Europe/Paris")`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** The canonical order of a chord set: plain string order, duplicates dropped. */
function canonicalTokens(tokens: readonly ChordToken[]): ChordToken[] {
  return [...new Set(tokens)].sort();
}

/** The one spelling of a (time zone, chord set) pair. Throws on an unknown time zone. */
export function encodeProgressParams(
  decoded: DecodedProgressParams,
): ChordProgressParams {
  assertTimeZone(decoded.timeZone);
  return {
    timeZone: decoded.timeZone,
    tokens: canonicalTokens(decoded.tokens).join(","),
  };
}

/**
 * Read the params back. Throws on an unknown time zone, on a string that is not
 * a chord token, and on a set not in its canonical spelling (unsorted or
 * repeated) — `encodeProgressParams` never produces one, so something built the
 * params by hand. An empty set is the empty string.
 */
export function decodeProgressParams(
  params: ChordProgressParams,
): DecodedProgressParams {
  assertTimeZone(params.timeZone);
  return {
    timeZone: params.timeZone,
    tokens: decodeTokenSet("tokens", params.tokens),
  };
}

function decodeTokenSet(name: string, text: string): ChordToken[] {
  const tokens =
    text === ""
      ? []
      : text.split(",").map((part) => {
          const parsed = ChordTokenSchema.safeParse(part);
          if (!parsed.success) {
            throw new Error(
              `chord.progress params: "${part}" is not a chord token`,
            );
          }
          return parsed.data;
        });
  const canonical = canonicalTokens(tokens).join(",");
  if (canonical !== text) {
    throw new Error(
      `chord.progress params: ${name} "${text}" are not in canonical form ("${canonical}"); build params with encodeProgressParams`,
    );
  }
  return tokens;
}

/**
 * The learner's standing: per chord of `tokens`, every unlisted (rare) chord
 * as one pool, today, and all time. Pushed
 * again whenever an answer is saved. One object whose `chords` holds one entry
 * per requested token, so the params bound it.
 *
 * Its params are `ChordProgressParams` by construction; build them with
 * `encodeProgressParams` (the loader refuses any other spelling). No
 * placeholder: until the server's first value lands the read is `pending`, so a
 * surface renders its loading state, never zeros.
 */
export const chordProgress = liveValue("chord.progress", {
  schema: ChordProgressSchema,
  params: ["timeZone", "tokens"],
});
