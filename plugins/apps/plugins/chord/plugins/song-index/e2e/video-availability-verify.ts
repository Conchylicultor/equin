// Drives the loop query's video check end to end against this checkout's
// deploy (`research/2026-09-18-apps-chord-video-availability.md`, verification
// steps 3–5):
//
//   1. `ensure` opens the index, and its status reaches `ready`;
//   2. a find with playable {I, IV, V}, IV practised — twice, timed: the
//      first call pays for the oEmbed checks of videos nobody has looked at, the
//      second finds most of them known. Every candidate's video is `ok` or
//      `unknown`, never one known to be unplayable;
//   3. a player error 150 (embedding refused) is reported for one video the find
//      returned, and the same find, re-run, no longer offers that video.
//
// Usage:
//   ./equin run plugins/apps/plugins/chord/plugins/song-index/e2e/video-availability-verify.ts [--url http://<ns>.localhost:9000] [--timeout-min 15]
//
// Mutates server state: records the request row, may start a load, stores the
// oEmbed answers for every video the finds touched, and records a (fake) player
// error on one real video — which then stays out of this deploy's loops until
// that evidence ages out or the player reports it playing.

import {
  numArg,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type {
  FindLoopsInput,
  LoopCandidate,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import { VideoStatusSchema } from "@plugins/apps/plugins/chord/plugins/video-availability/core";
import { z } from "zod";
import { ensureReady, findLoops, major, postJson } from "./flows";

const r = report("chord video availability");
const timeoutMs = numArg("timeout-min", 15) * 60_000;

const I = major(0);
const IV = major(5);
const V = major(7);
const FIND: FindLoopsInput = {
  playable: [I, IV, V],
  practised: [IV],
  extras: 0,
  limit: 50,
};

async function find(): Promise<{ candidates: LoopCandidate[]; ms: number }> {
  const t0 = performance.now();
  const res = await findLoops(FIND);
  const ms = performance.now() - t0;
  if (res.kind !== "ready") {
    r.fail("find answers ready once the status is ready", JSON.stringify(res));
    return r.finish();
  }
  return { candidates: res.candidates, ms };
}

function statusCounts(candidates: readonly LoopCandidate[]): string {
  const counts: Record<string, number> = {};
  for (const { videoStatus } of candidates)
    counts[videoStatus] = (counts[videoStatus] ?? 0) + 1;
  return JSON.stringify(counts);
}

// ── 1. ensure → ready ────────────────────────────────────────────────────────

await ensureReady(r, timeoutMs);

// ── 2. find, twice: every video is ok or unknown ─────────────────────────────

const first = await find();
const second = await find();
r.note(
  `find over HTTP: first ${first.ms.toFixed(1)} ms (${first.candidates.length} candidates), second ${second.ms.toFixed(1)} ms (${second.candidates.length})`,
);
r.note(
  `video statuses: first ${statusCounts(first.candidates)}, second ${statusCounts(second.candidates)}`,
);
r.ok("find returns windows", first.candidates.length > 0, "no candidates");
for (const [label, { candidates }] of [
  ["first", first],
  ["second", second],
] as const) {
  const unplayable = candidates.filter(
    (c) => c.videoStatus !== "ok" && c.videoStatus !== "unknown",
  );
  r.ok(
    `every candidate's video is ok or unknown (${label} find)`,
    unplayable.length === 0,
    JSON.stringify(unplayable.map((c) => [c.videoId, c.videoStatus])),
  );
}

// ── 3. a player error 150 removes the video ──────────────────────────────────

const victim = first.candidates[0];
if (victim === undefined) {
  r.fail("a candidate to report a player error for", "the find returned none");
  await r.finish();
} else {
  r.note(
    `reporting error 150 for ${victim.videoId} (${victim.artist} — ${victim.song}, ${victim.sectionName}, was ${victim.videoStatus})`,
  );
  const { status } = z
    .object({ status: VideoStatusSchema })
    .parse(
      await postJson(
        `/api/chord/videos/${encodeURIComponent(victim.videoId)}/playback`,
        { outcome: "error", code: 150 },
      ),
    );
  // The player's report outranks an oEmbed `ok`: only an oEmbed `gone` would
  // win over it, and the find just offered this video, so it was not gone.
  r.ok(
    "the video now resolves to not-embeddable",
    status === "not-embeddable",
    status,
  );

  // `find` is a random pick, so one miss proves little: the video is checked
  // against several finds, and against every section of it they return.
  const after: LoopCandidate[] = [];
  for (let i = 0; i < 5; i++) after.push(...(await find()).candidates);
  const stillOffered = after.filter((c) => c.videoId === victim.videoId);
  r.ok(
    "the reported video is no longer offered (5 finds)",
    stillOffered.length === 0,
    JSON.stringify(stillOffered.map((c) => c.sectionId)),
  );
  r.ok(
    "the reported section is gone from the same find",
    after.every((c) => c.sectionId !== victim.sectionId),
  );
}

await r.finish();
