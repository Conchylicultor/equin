/**
 * The verdict view's truth table, against a real Postgres: each source alone,
 * the two in conflict both ways, and evidence aged past the TTL.
 *
 * A throwaway database with the ledger table and the view compiled from its
 * drizzle definition — the same `compileCreateView` the boot rebuild runs — so
 * what is asserted is the view that ships, read back through its decoder.
 *
 * Requires the running embedded cluster (`./equin build` first);
 * `createTestDb` throws loudly rather than skipping when it is not up.
 *
 * Run: `./equin test plugins/apps/plugins/chord/plugins/video-availability`
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import type { EmbedStatus } from "@plugins/integrations/plugins/youtube/core";
import { EVIDENCE_TTL_DAYS, type VideoStatus } from "../../core";
import { _chordVideos } from "./tables";
import { chordVideoStatus } from "./views";

let t: TestDb;

const DAY_MS = 24 * 60 * 60 * 1000;
const fresh = new Date(Date.now() - DAY_MS);
const stale = new Date(Date.now() - (EVIDENCE_TTL_DAYS + 1) * DAY_MS);

type Observation = { status: EmbedStatus | null; at: Date };

/** Each case: what oEmbed and the player last said, and the verdict expected. */
const CASES: {
  id: string;
  oembed?: Observation;
  player?: Observation;
  expected: VideoStatus;
}[] = [
  // Each source alone.
  { id: "oembed-ok", oembed: { status: "ok", at: fresh }, expected: "ok" },
  {
    id: "oembed-gone",
    oembed: { status: "gone", at: fresh },
    expected: "gone",
  },
  {
    id: "oembed-blocked",
    oembed: { status: "not-embeddable", at: fresh },
    expected: "not-embeddable",
  },
  { id: "player-ok", player: { status: "ok", at: fresh }, expected: "ok" },
  {
    id: "player-blocked",
    player: { status: "not-embeddable", at: fresh },
    expected: "not-embeddable",
  },
  // In conflict: the player outranks oEmbed's `ok`, and oEmbed's `gone` outranks the player.
  {
    id: "player-wins",
    oembed: { status: "ok", at: fresh },
    player: { status: "not-embeddable", at: fresh },
    expected: "not-embeddable",
  },
  {
    id: "gone-wins",
    oembed: { status: "gone", at: fresh },
    player: { status: "ok", at: fresh },
    expected: "gone",
  },
  // Past the TTL, evidence counts as none.
  {
    id: "stale-gone",
    oembed: { status: "gone", at: stale },
    expected: "unknown",
  },
  {
    id: "stale-gone-fresh-player",
    oembed: { status: "gone", at: stale },
    player: { status: "ok", at: fresh },
    expected: "ok",
  },
  {
    id: "stale-player",
    oembed: { status: "ok", at: fresh },
    player: { status: "not-embeddable", at: stale },
    expected: "ok",
  },
  // An answer that said nothing (a 500) is no evidence.
  { id: "undecided", oembed: { status: null, at: fresh }, expected: "unknown" },
];

beforeAll(async () => {
  t = await createTestDb({ prefix: "chord_videos_test" });
  // The throwaway database runs no migrations. The columns mirror `tables.ts`.
  await t.db.execute(sql`
    CREATE TABLE chord_videos (
      video_id text PRIMARY KEY,
      oembed_status text,
      oembed_code integer,
      oembed_checked_at timestamp with time zone,
      player_status text,
      player_code integer,
      player_checked_at timestamp with time zone
    )
  `);
  await t.db.execute(
    sql.raw(
      compileCreateView({
        name: "chord_video_status_v",
        view: chordVideoStatus,
        dependsOn: [],
      }),
    ),
  );
  await t.db.insert(_chordVideos).values(
    CASES.map((c) => ({
      videoId: c.id,
      oembedStatus: c.oembed?.status ?? null,
      oembedCheckedAt: c.oembed?.at ?? null,
      playerStatus: c.player?.status ?? null,
      playerCheckedAt: c.player?.at ?? null,
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the view resolves each case as the rule says", async () => {
  const rows = await t.db
    .select({
      videoId: chordVideoStatus.videoId,
      status: chordVideoStatus.status,
    })
    .from(chordVideoStatus);
  const actual = Object.fromEntries(rows.map((r) => [r.videoId, r.status]));
  const expected = Object.fromEntries(CASES.map((c) => [c.id, c.expected]));
  expect(actual).toEqual(expected);
});
