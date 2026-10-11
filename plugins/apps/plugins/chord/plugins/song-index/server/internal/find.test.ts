import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { chordTokenFromParts, compactChord, deriveSection } from "../../core";
import {
  FindLoopsBodySchema,
  NextChordsBodySchema,
} from "../../core/endpoints";
import { chord, section, windowsOf } from "../../core/test-sections";
import {
  chordsInWindow,
  findLoopsWhere,
  nextChordsQuery,
  playableVideoWhere,
  tokenSetsQuery,
} from "./find";

const dialect = new PgDialect();
const I = "0:4-3/0";
const IV = "5:4-3/0";
const V = "7:4-3/0";

describe("findLoopsWhere", () => {
  it("leads with the practised overlap and binds the playable set as one array", () => {
    const body = FindLoopsBodySchema.parse({
      playable: [I, IV, V],
      practised: [IV],
      extras: 0,
      limit: 10,
    });
    const { sql, params } = dialect.sqlToQuery(findLoopsWhere(body));
    expect(sql).toContain(`"chord_loop_windows"."shape" = $1`);
    expect(sql).toContain(`"chord_loop_windows"."chord_tokens" && $2`);
    expect(sql).toContain(`"chord_loop_windows"."chord_tokens" <@ $3`);
    expect(sql).not.toContain("@> $");
    // The column's array encoder sends each array as one Postgres array literal.
    expect(params).toEqual(["phrase", `{"${IV}"}`, `{"${I}","${IV}","${V}"}`]);
  });

  it("a focus adds the windows-holding-it test", () => {
    const body = FindLoopsBodySchema.parse({
      playable: [I, IV, V],
      practised: [I, IV],
      extras: 0,
      focus: IV,
      limit: 10,
    });
    const { sql, params } = dialect.sqlToQuery(findLoopsWhere(body));
    expect(sql).toContain(`"chord_loop_windows"."chord_tokens" @> $2`);
    expect(sql).toContain(`"chord_loop_windows"."chord_tokens" && $3`);
    expect(params.slice(1, 3)).toEqual([`{"${IV}"}`, `{"${I}","${IV}"}`]);
  });

  it("extras 1 and 2 count the chords outside the playable set instead of <@", () => {
    for (const extras of [1, 2] as const) {
      const body = FindLoopsBodySchema.parse({
        playable: [I, IV],
        practised: [I],
        extras,
        limit: 10,
      });
      const { sql, params } = dialect.sqlToQuery(findLoopsWhere(body));
      expect(sql).not.toContain("<@");
      expect(sql).toContain(
        `cardinality(array(SELECT t FROM unnest("chord_loop_windows"."chord_tokens") AS t WHERE NOT (t = ANY($3::text[])))) <= $4`,
      );
      expect(params.slice(2)).toEqual([[I, IV], extras]);
    }
  });

  it("extras any drops the containment test altogether", () => {
    const body = FindLoopsBodySchema.parse({
      playable: [I, IV],
      practised: [I],
      extras: "any",
      limit: 10,
    });
    const { sql } = dialect.sqlToQuery(findLoopsWhere(body));
    expect(sql).not.toContain("<@");
    expect(sql).not.toContain("cardinality");
    expect(sql).toContain("&&");
  });

  it("adds the optional filters only when given", () => {
    const body = FindLoopsBodySchema.parse({
      playable: [I, IV],
      practised: [I],
      extras: 0,
      requireFeatures: ["seventh"],
      forbidFeatures: ["borrowed", "applied"],
      excludeSectionIds: ["qveoYyGGodn"],
      limit: 5,
    });
    const { sql, params } = dialect.sqlToQuery(findLoopsWhere(body));
    expect(sql).toContain(`"chord_loop_windows"."features" @> $4`);
    expect(sql).toContain(`not "chord_loop_windows"."features" && $5`);
    expect(sql).toContain(`"chord_loop_windows"."section_id" not in ($6)`);
    expect(sql).not.toContain("key_mode");
    expect(params.slice(3)).toEqual([
      '{"seventh"}',
      '{"borrowed","applied"}',
      "qveoYyGGodn",
    ]);
  });

  it("refuses a practised chord that is not playable, and a focus not practised", () => {
    const notPlayable = FindLoopsBodySchema.safeParse({
      playable: [I, V],
      practised: [IV],
      extras: 0,
      limit: 10,
    });
    expect(notPlayable.success).toBe(false);
    expect(notPlayable.error?.issues[0]?.path).toEqual(["practised"]);
    const badFocus = FindLoopsBodySchema.safeParse({
      playable: [I, V],
      practised: [I],
      extras: 0,
      focus: V,
      limit: 10,
    });
    expect(badFocus.success).toBe(false);
    expect(badFocus.error?.issues[0]?.path).toEqual(["focus"]);
  });
});

describe("playableVideoWhere", () => {
  it("keeps a video with no status row, and leaves out the unplayable ones", () => {
    // Fail open: a left-joined video nobody has checked has a NULL status and
    // must stay offered. Only the statuses that cannot play are excluded.
    const { sql, params } = dialect.sqlToQuery(playableVideoWhere());
    expect(sql).toMatch(/is null or .* not in \(\$1, \$2\)/);
    expect(params).toEqual(["gone", "not-embeddable"]);
  });

  it("is not part of the windows-only WHERE", () => {
    // `findLoopsWhere` stands on the windows table alone, like the counts,
    // which deliberately ignore the videos.
    const body = FindLoopsBodySchema.parse({
      playable: [I, IV],
      practised: [I],
      extras: 0,
      limit: 10,
    });
    const { sql } = dialect.sqlToQuery(findLoopsWhere(body));
    expect(sql).not.toContain("status");
  });
});

describe("nextChordsQuery", () => {
  it("binds the unlocked set as one text[] parameter", () => {
    const body = NextChordsBodySchema.parse({ unlocked: [I, IV, V] });
    const { sql, params } = dialect.sqlToQuery(nextChordsQuery(body));
    expect(sql).toContain("NOT (t = ANY($1::text[]))");
    expect(sql).toContain("cardinality(foreign_tokens) = 1");
    expect(params).toEqual([[I, IV, V], "phrase", 20]);
  });

  it("groups by token AND mode in one scan, ranked by the largest mode", () => {
    // One pass over the windows answers every mode: the modes are grouped
    // alongside the token, then folded into one row per token. `limit` counts
    // tokens, so it is applied after the fold, and the ranking is the biggest
    // single mode — a chord that is huge in minor must not sink under the sum.
    const body = NextChordsBodySchema.parse({ unlocked: [I] });
    const { sql } = dialect.sqlToQuery(nextChordsQuery(body));
    expect(sql).toContain("GROUP BY 1, 2");
    expect(sql).toContain('jsonb_object_agg(key_mode, windows) AS "byMode"');
    expect(sql).toContain("ORDER BY max(windows) DESC, token");
    expect(sql.lastIndexOf("LIMIT")).toBeGreaterThan(
      sql.indexOf("GROUP BY token"),
    );
  });

  it("reads every window of the shape, sharing a chord with the set or not", () => {
    // The count's contract: a window whose chords are ALL outside the set still
    // has one distinct chord outside it when it is a vamp, and unlocking that
    // chord makes `find` return it. An `&&` prefilter would drop exactly those.
    // `find-db.test.ts` runs the query over such a window on a real database.
    const body = NextChordsBodySchema.parse({ unlocked: [I, IV, V] });
    const { sql } = dialect.sqlToQuery(nextChordsQuery(body));
    expect(sql).not.toContain('chord_tokens" &&');
  });

  it("filters modes when given", () => {
    const body = NextChordsBodySchema.parse({
      unlocked: [I],
      modes: ["minor"],
      limit: 5,
    });
    const { sql, params } = dialect.sqlToQuery(nextChordsQuery(body));
    expect(sql).toContain(`"chord_loop_windows"."key_mode" in ($3)`);
    expect(params).toEqual([[I], "phrase", "minor", 5]);
  });
});

describe("tokenSetsQuery", () => {
  it("groups the windows of one shape by key mode and chord set", () => {
    const { sql, params } = dialect.sqlToQuery(
      tokenSetsQuery({ shape: "bars-4" }),
    );
    expect(sql).toContain("GROUP BY 1, 2");
    expect(sql).toContain('"chord_loop_windows"."shape" = $1');
    expect(params).toEqual(["bars-4"]);
  });
});

describe("chordsInWindow", () => {
  // A section where one chord ends a hair past a bar line: 8 bars of 4/4, one
  // chord per bar, the first a ii that rings 1e-9 beats into bar 2. Comparing
  // beats without a tolerance (`beat + duration > startBeat`) keeps it in the
  // window starting at bar 2 — the window whose derivation, which does use the
  // tolerance, never counted it.
  const DRIFT = 1e-9;
  const roots = [2, 4, 5, 1, 4, 5, 1, 1];
  const chords = roots.map((root, i) =>
    chord(1 + i * 4, i === 0 ? 4 + DRIFT : 4, { root }),
  );
  const derived = deriveSection(section(chords, { endBeat: 33 }));
  if (derived.kind !== "indexed") throw new Error("the fixture must index");
  const stored = derived.chords.map(compactChord);
  const windows = windowsOf(derived, "bars-4");

  it("returns exactly the chords the window was derived from", () => {
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      const chords = chordsInWindow(stored, window);
      expect(chords.map((c) => c.token).filter((t) => t !== null)).toHaveLength(
        window.chordCount,
      );
      for (const { token } of chords) {
        if (token !== null) expect(window.chordTokens).toContain(token);
      }
    }
  });

  it("leaves out a chord that only drifts past the window's first beat", () => {
    const secondBar = windows.find((w) => w.startBeat === 5);
    if (secondBar === undefined) throw new Error("no window at beat 5");
    const ii = chordTokenFromParts({
      root: 2,
      intervals: [3, 4],
      inversion: 0,
    });
    expect(secondBar.chordTokens).not.toContain(ii);
    expect(chordsInWindow(stored, secondBar).map((c) => c.beat)).not.toContain(
      1,
    );
  });
});
