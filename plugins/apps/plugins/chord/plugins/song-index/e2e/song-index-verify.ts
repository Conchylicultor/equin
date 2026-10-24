// Drives the chord song index end to end against this checkout's deploy:
//
//   1. `ensure` opens the index, and its status reaches `ready` (a first run on a
//      machine downloads the dump and builds the snapshot: minutes);
//   2. find with playable {I, IV, V}, IV practised, returns windows whose
//      chords all lie inside the set, each containing IV;
//   3. next-chords for {I, IV, V} returns a list ranked by the biggest single
//      key mode's window count, each row split by mode;
//   4. 100 random finds per extras setting (0, 1, 2, any), timed, with p50 /
//      p95 reported (target: p95 < 50 ms for extras 0 on the full index; 1 and 2
//      scan like next-chords — a worktree loads the sample, so the numbers there
//      are only indicative).
//
// Usage:
//   ./equin run plugins/apps/plugins/chord/plugins/song-index/e2e/song-index-verify.ts [--url http://<ns>.localhost:9000] [--timeout-min 15]
//
// Mutates server state: records the request row and may start a load.

import {
  numArg,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  bestModeWindows,
  windowsInModes,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  FindResponseSchema,
  NextResponseSchema,
  ensureReady,
  major,
  minor,
  postJson,
} from "./flows";

const r = report("chord song index");
const timeoutMs = numArg("timeout-min", 15) * 60_000;

const I = major(0);
const IV = major(5);
const V = major(7);

// ── 1. ensure → ready ────────────────────────────────────────────────────────

await ensureReady(r, timeoutMs);

// ── 2. find {I, IV, V}, IV practised ─────────────────────────────────────────

const found = FindResponseSchema.parse(
  await postJson("/api/chord/loops/find", {
    playable: [I, IV, V],
    practised: [IV],
    extras: 0,
    limit: 50,
  }),
);
if (found.kind !== "ready") {
  r.fail("find answers ready once the status is ready", JSON.stringify(found));
} else {
  const unlocked = new Set<string>([I, IV, V]);
  r.ok("find returns windows", found.candidates.length > 0, "no candidates");
  r.ok(
    "every window's chords are inside {I, IV, V}",
    found.candidates.every((c) =>
      c.window.chordTokens.every((t) => unlocked.has(t)),
    ),
    JSON.stringify(found.candidates.map((c) => c.window.chordTokens)),
  );
  r.ok(
    "every window contains IV",
    found.candidates.every((c) => c.window.chordTokens.includes(IV)),
  );
  r.ok(
    "every candidate carries the chords sounding in its window",
    found.candidates.every(
      (c) =>
        c.chords.some((chord) => chord.token === IV) &&
        c.chords.every(
          (chord) => chord.token === null || unlocked.has(chord.token),
        ),
    ),
  );
  const sample = found.candidates[0];
  if (sample) {
    r.note(
      `e.g. ${sample.artist} — ${sample.song} (${sample.sectionName}), beats ${sample.window.startBeat}–${sample.window.endBeat}, video ${sample.videoId}`,
    );
  }
}

// ── 3. next chords after {I, IV, V} ──────────────────────────────────────────

const next = NextResponseSchema.parse(
  await postJson("/api/chord/loops/next-chords", {
    unlocked: [I, IV, V],
    limit: 10,
  }),
);
if (next.kind !== "ready") {
  r.fail("next-chords answers ready", JSON.stringify(next));
} else {
  r.ok(
    "next-chords returns a ranked list",
    next.nextChords.length > 0,
    "empty",
  );
  r.ok(
    "ranked by the largest single mode's window count, most first",
    next.nextChords.every(
      (n, i, all) =>
        i === 0 || bestModeWindows(all[i - 1] ?? n) >= bestModeWindows(n),
    ),
    JSON.stringify(next.nextChords),
  );
  r.ok(
    "no unlocked chord is proposed",
    next.nextChords.every((n) => ![I, IV, V].includes(n.token)),
  );
  r.note(
    `top next chords (major / best mode): ${next.nextChords
      .map(
        (n) =>
          `${n.token}×${windowsInModes(n, ["major"])}/${bestModeWindows(n)}`,
      )
      .join(", ")}`,
  );
  r.note(
    `vi (${minor(9)}) rank: ${next.nextChords.findIndex((n) => n.token === minor(9)) + 1 || "not in top 10"}`,
  );
}

// ── 4. latency over 100 random finds ────────────────────────────────────────

const POOL = [
  major(0),
  major(5),
  major(7),
  minor(9),
  minor(2),
  minor(4),
  major(10),
  major(3),
];
for (const extras of [0, 1, 2, "any"] as const) {
  const timings: number[] = [];
  for (let i = 0; i < 100; i++) {
    const size = 2 + Math.floor(Math.random() * (POOL.length - 1));
    const playable = [...POOL].sort(() => Math.random() - 0.5).slice(0, size);
    const practised = playable.slice(0, 1 + Math.floor(size / 2));
    const t0 = performance.now();
    const res = FindResponseSchema.parse(
      await postJson("/api/chord/loops/find", {
        playable,
        practised,
        extras,
        limit: 20,
      }),
    );
    timings.push(performance.now() - t0);
    if (res.kind !== "ready") {
      r.fail("find stays ready during the timing run", JSON.stringify(res));
      break;
    }
  }
  timings.sort((a, b) => a - b);
  const pct = (p: number) =>
    timings[
      Math.min(timings.length - 1, Math.ceil((p / 100) * timings.length) - 1)
    ] ?? NaN;
  r.note(
    `find (extras ${extras}) over HTTP, ${timings.length} random calls: p50 ${pct(50).toFixed(1)} ms, p95 ${pct(95).toFixed(1)} ms, max ${pct(100).toFixed(1)} ms`,
  );
  r.ok(`100 random finds answered (extras ${extras})`, timings.length === 100);
}

await r.finish();
