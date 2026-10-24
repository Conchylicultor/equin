// ─── Align UG tabs against cached beat features ──────────────────────────────
//
//   ./equin run plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/scripts/calibrate.ts \
//     <features.json>... <ug-tab.json>... [--chords | --bars]
//   ./equin run …/calibrate.ts --set [--fetch http://<namespace>.localhost:9000]
//
// <features.json>: a cached BeatFeatures file
//   (~/.singularity/cache/beat-features/v<N>/<settingsKey>/<videoId>.json).
// <ug-tab.json>: a UgTab, e.g. the body `POST /api/sonata/sources/ultimate-guitar/fetch`
//   returns. Each file is recognised by its shape, in any order.
//
// One features file and one tab: prints the transposition, the score and what
// it is made of (the sheet-constrained, free and all-filler log-scores per beat,
// the fit they give and the sheet coverage), the filler fraction, the decode
// time and the section-occurrence timeline — with --chords, every chord segment
// too; with --bars, one line per bar: the path's chord against the best sheet
// chord and the best triad, with their correlations. Several of either: one
// summary line per (tab, features) pair.
//
// --set: the calibration set below (C's 10 songs plus B's original-key Take On
// Me). Every sheet against every recording: the score matrix, the separation
// between right and wrong pairs, and what the resolver's accept rule picks from
// each song's candidates (in the order the resolver ranked them). Tabs are read
// from the `ug-calibration` cache dir; --fetch fills the missing ones through
// that deploy's UG fetch endpoint. Features are read from the beat-features
// cache (final0 / fast chroma); a recording with none is listed and skipped.
//
// Results: research/2026-10-01-apps-sonata-ug-alignment-aligner.md (B) and
// research/2026-10-07-apps-sonata-ug-alignment-scoring.md (D).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ANALYSIS_VERSION,
  BeatFeaturesSchema,
  settingsKey,
  type BeatFeatures,
} from "@plugins/infra/plugins/audio-analysis/core";
import { beatFeaturesCacheDir } from "@plugins/infra/plugins/audio-analysis/data-dirs";
import {
  parseUgTab,
  UgTabSchema,
  type UgTab,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { sheetHash, WEAK_MATCH_THRESHOLD } from "../core";
import { alignWithDiagnostics, barDiagnostics } from "../core/internal/align";
import { chooseCandidate } from "../core/internal/accept";
import { ugCalibrationTabsDir } from "../data-dirs";

// ── The calibration set ──────────────────────────────────────────────────────

/**
 * What a recording is, for the song it belongs to:
 * - `right`: the studio recording (or an upload of its audio, or its official
 *   video) — what the sheet transcribes.
 * - `other-version`: the same song performed otherwise (a live bootleg).
 * Against another song's sheet, any recording is a wrong pair.
 */
type RecordingKind = "right" | "other-version";

interface CalibrationSong {
  /** Short label for the matrix. */
  name: string;
  /** Which song (recordings of the same work are never wrong pairs). */
  work: string;
  tabUrl: string;
  /**
   * The sheet transcribes another arrangement than the recordings (Take On
   * Me's most-voted tab is MTV Unplugged): its same-work pairs are reported
   * apart from the separation.
   */
  otherArrangement?: true;
  /** The resolver's candidates in its rank order (from C's run), with what each is. */
  candidates: { videoId: string; kind: RecordingKind }[];
}

const UG = "https://tabs.ultimate-guitar.com/tab";

const CALIBRATION_SET: CalibrationSong[] = [
  {
    name: "Let It Be",
    work: "let-it-be",
    tabUrl: `${UG}/the-beatles/let-it-be-chords-17427`,
    candidates: [{ videoId: "QDYfEBY9NM4", kind: "right" }],
  },
  {
    name: "Wonderwall",
    work: "wonderwall",
    tabUrl: `${UG}/oasis/wonderwall-chords-39144`,
    candidates: [
      { videoId: "FVdjZYfDuLE", kind: "right" },
      { videoId: "6hzrDeceEKc", kind: "right" },
      { videoId: "bx1Bh8ZvH84", kind: "right" },
    ],
  },
  {
    name: "Someone Like",
    work: "someone-like-you",
    tabUrl: `${UG}/adele/someone-like-you-chords-1006751`,
    candidates: [{ videoId: "hLQl3WQQoQ0", kind: "right" }],
  },
  {
    name: "TakeOnMe unpl",
    work: "take-on-me",
    tabUrl: `${UG}/a-ha/take-on-me-chords-1842621`,
    otherArrangement: true,
    candidates: [
      { videoId: "-iKeUC5_Wyw", kind: "right" },
      { videoId: "MIgK3zOk0zg", kind: "right" },
    ],
  },
  {
    name: "TakeOnMe orig",
    work: "take-on-me",
    tabUrl: `${UG}/a-ha/take-on-me-chords-390284`,
    candidates: [
      { videoId: "-iKeUC5_Wyw", kind: "right" },
      { videoId: "MIgK3zOk0zg", kind: "right" },
    ],
  },
  {
    name: "Livin Prayer",
    work: "livin-on-a-prayer",
    tabUrl: `${UG}/bon-jovi/livin-on-a-prayer-chords-1185747`,
    candidates: [{ videoId: "lDK9QqIzhwk", kind: "right" }],
  },
  {
    name: "Skinny Love",
    work: "skinny-love",
    tabUrl: `${UG}/bon-iver/skinny-love-chords-835053`,
    candidates: [
      { videoId: "95FyXUHv8hk", kind: "right" },
      { videoId: "5l8otWSs3Ro", kind: "other-version" },
    ],
  },
  {
    name: "Hotel Calif",
    work: "hotel-california",
    tabUrl: `${UG}/eagles/hotel-california-chords-46190`,
    candidates: [{ videoId: "dLl4PZtxia8", kind: "right" }],
  },
  {
    name: "Hallelujah",
    work: "hallelujah",
    tabUrl: `${UG}/leonard-cohen/hallelujah-chords-64977`,
    candidates: [{ videoId: "ttEMYvpoR-k", kind: "right" }],
  },
  {
    name: "Shape Of You",
    work: "shape-of-you",
    tabUrl: `${UG}/ed-sheeran/shape-of-you-chords-1928431`,
    candidates: [
      { videoId: "JGwWNGJdvx8", kind: "right" },
      { videoId: "_dK2tDK9grQ", kind: "right" },
      { videoId: "liTfD88dbCo", kind: "right" },
    ],
  },
  {
    name: "Riptide",
    work: "riptide",
    tabUrl: `${UG}/vance-joy/riptide-chords-1237247`,
    candidates: [{ videoId: "uJ_1HMAGb4k", kind: "right" }],
  },
];

/** Recordings of no sheet in the set: wrong against every sheet. */
const NEGATIVE_RECORDINGS = ["dQw4w9WgXcQ"];

// ── One alignment ────────────────────────────────────────────────────────────

function run(tab: UgTab, features: BeatFeatures) {
  const parsed = parseUgTab(tab);
  const t0 = performance.now();
  const { record, diagnostics } = alignWithDiagnostics(parsed, features, {
    capo: tab.capo,
    sheetHash: sheetHash(tab.content),
    settingsKey: "calibration",
  });
  const ms = performance.now() - t0;
  let gapBeats = 0;
  for (const seg of record.segments)
    if (seg.kind === "gap") gapBeats += seg.endBeat - seg.startBeat;
  const T = record.beats.length;
  const summary = [
    `transpose ${String(record.transpose).padStart(2)}`,
    `score ${record.score.toFixed(3)} ${record.score >= WEAK_MATCH_THRESHOLD ? "applied" : "weak   "}`,
    `constrained ${diagnostics.constrained.toFixed(3)}`,
    `free ${diagnostics.free.toFixed(3)}`,
    `base ${diagnostics.base.toFixed(3)}`,
    `fit ${diagnostics.fit.toFixed(3)}`,
    `cover ${diagnostics.coverage.toFixed(2)}`,
    `filler ${(gapBeats / T).toFixed(2)}`,
    `${String(T).padStart(3)} beats`,
    `${ms.toFixed(0).padStart(4)} ms`,
  ].join("  ");
  return { parsed, record, diagnostics, summary };
}

// ── --set ────────────────────────────────────────────────────────────────────

async function loadTab(url: string, fetchFrom: string | null): Promise<UgTab> {
  const id = /(\d+)$/.exec(url)?.[1];
  if (id === undefined) throw new Error(`No tab id in ${url}`);
  const dir = ugCalibrationTabsDir.path;
  const path = join(dir, `${id}.json`);
  if (existsSync(path))
    return UgTabSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (fetchFrom === null)
    throw new Error(
      `Tab ${id} is not cached in ${dir}: pass --fetch http://<namespace>.localhost:9000 to fetch it.`,
    );
  const res = await fetch(
    `${fetchFrom}/api/sonata/sources/ultimate-guitar/fetch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
  if (!res.ok)
    throw new Error(
      `Fetching tab ${id}: HTTP ${res.status} ${await res.text()}`,
    );
  const tab = UgTabSchema.parse(await res.json());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tab));
  return tab;
}

/** The features the resolver uses by default (final0 beats, fast chroma). */
const SETTINGS = { beatModel: "final0", chroma: "fast" } as const;

/**
 * A video's cached features, or null when none are cached. Read off the cache
 * layout (`v<N>/<settingsKey>/<videoId>.json`, present only once validated)
 * rather than through the server's readBeatFeatures, which needs a backend's
 * runtime (config) this script does not have.
 */
function loadFeatures(videoId: string): BeatFeatures | null {
  const path = join(
    beatFeaturesCacheDir.path,
    `v${ANALYSIS_VERSION}`,
    settingsKey(SETTINGS),
    `${videoId}.json`,
  );
  if (!existsSync(path)) return null;
  return BeatFeaturesSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

type PairKind = "right" | "other-version" | "other-arrangement" | "wrong";

async function runSet(fetchFrom: string | null): Promise<void> {
  const tabs = new Map<string, UgTab>();
  for (const song of CALIBRATION_SET)
    tabs.set(song.name, await loadTab(song.tabUrl, fetchFrom));

  const recordings: { videoId: string; work: string | null }[] = [];
  for (const song of CALIBRATION_SET)
    for (const c of song.candidates)
      if (!recordings.some((r) => r.videoId === c.videoId))
        recordings.push({ videoId: c.videoId, work: song.work });
  for (const videoId of NEGATIVE_RECORDINGS)
    recordings.push({ videoId, work: null });

  const features = new Map<string, BeatFeatures>();
  for (const r of recordings) {
    const f = loadFeatures(r.videoId);
    if (f === null) console.log(`(no cached features for ${r.videoId})`);
    else features.set(r.videoId, f);
  }

  const kindOf = (song: CalibrationSong, videoId: string): PairKind => {
    const rec = recordings.find((r) => r.videoId === videoId)!;
    if (rec.work !== song.work) return "wrong";
    if (song.otherArrangement) return "other-arrangement";
    // A recording of the same work: its kind as listed under any sheet of it.
    for (const s of CALIBRATION_SET) {
      if (s.work !== song.work) continue;
      const c = s.candidates.find((x) => x.videoId === videoId);
      if (c !== undefined) return c.kind;
    }
    return "right";
  };

  const pairs: {
    song: string;
    videoId: string;
    kind: PairKind;
    score: number;
    fit: number;
    coverage: number;
    transpose: number;
  }[] = [];
  for (const song of CALIBRATION_SET) {
    const tab = tabs.get(song.name)!;
    for (const [videoId, f] of features) {
      const { record, diagnostics } = run(tab, f);
      pairs.push({
        song: song.name,
        videoId,
        kind: kindOf(song, videoId),
        score: record.score,
        fit: diagnostics.fit,
        coverage: diagnostics.coverage,
        transpose: record.transpose,
      });
    }
  }

  // The matrix: one row per sheet, one column per recording.
  const ids = [...features.keys()];
  const mark: Record<PairKind, string> = {
    right: "*",
    "other-version": "~",
    "other-arrangement": "^",
    wrong: " ",
  };
  console.log(
    `\nScore matrix (* right, ~ other version, ^ other arrangement)\n${"".padEnd(14)}${ids.map((id) => id.slice(0, 6).padStart(7)).join("")}`,
  );
  for (const song of CALIBRATION_SET) {
    const cells = ids.map((id) => {
      const p = pairs.find((x) => x.song === song.name && x.videoId === id)!;
      return `${p.score.toFixed(2)}${mark[p.kind]}`.padStart(7);
    });
    console.log(`${song.name.padEnd(14)}${cells.join("")}`);
  }

  // The same-work pairs, term by term.
  console.log("\nSame-song pairs");
  for (const p of pairs.filter((x) => x.kind !== "wrong"))
    console.log(
      `  ${p.song.padEnd(14)} ${p.videoId.padEnd(12)} ${p.kind.padEnd(17)} score ${p.score.toFixed(3)}  fit ${p.fit.toFixed(3)}  cover ${p.coverage.toFixed(2)}  transpose ${p.transpose}`,
    );

  const right = pairs.filter((p) => p.kind === "right");
  const wrong = pairs.filter((p) => p.kind === "wrong");
  const minRight = right.reduce((a, b) => (b.score < a.score ? b : a));
  const maxWrong = wrong.reduce((a, b) => (b.score > a.score ? b : a));
  const topWrong = [...wrong].sort((a, b) => b.score - a.score).slice(0, 5);
  console.log("\nTop wrong pairs");
  for (const p of [...wrong].sort((a, b) => b.score - a.score).slice(0, 12))
    console.log(
      `  ${p.song.padEnd(14)} ${p.videoId.padEnd(12)} score ${p.score.toFixed(3)}  fit ${p.fit.toFixed(3)}  cover ${p.coverage.toFixed(2)}`,
    );
  console.log(
    `\nSeparation: min right ${minRight.score.toFixed(3)} (${minRight.song} × ${minRight.videoId}), max wrong ${maxWrong.score.toFixed(3)} (${maxWrong.song} × ${maxWrong.videoId}), margin ${(minRight.score - maxWrong.score).toFixed(3)}`,
  );
  console.log(
    `Threshold ${WEAK_MATCH_THRESHOLD}: right below it ${right.filter((p) => p.score < WEAK_MATCH_THRESHOLD).length}/${right.length}, wrong at or above it ${wrong.filter((p) => p.score >= WEAK_MATCH_THRESHOLD).length}/${wrong.length}`,
  );
  console.log(
    `Wrong at or above: ${[0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((x) => `${x} ${wrong.filter((p) => p.score >= x).length}`).join(", ")}; right below: ${[0.5, 0.55, 0.6].map((x) => `${x} ${right.filter((p) => p.score < x).length}`).join(", ")}`,
  );
  console.log("Per sheet: min right − max wrong recording");
  for (const song of CALIBRATION_SET) {
    const mine = right.filter((p) => p.song === song.name);
    const theirs = wrong.filter((p) => p.song === song.name);
    if (mine.length === 0) continue;
    const lo = Math.min(...mine.map((p) => p.score));
    const hi = theirs.reduce((a, b) => (b.score > a.score ? b : a));
    console.log(
      `  ${song.name.padEnd(14)} right ≥ ${lo.toFixed(3)}  wrong ≤ ${hi.score.toFixed(3)} (${hi.videoId})  margin ${(lo - hi.score).toFixed(3)}`,
    );
  }
  console.log(
    `Top wrong: ${topWrong.map((p) => `${p.song}×${p.videoId} ${p.score.toFixed(3)}`).join(", ")}`,
  );

  // The pick: the accept rule over each song's candidates in rank order.
  console.log("\nPick simulation");
  for (const song of CALIBRATION_SET) {
    const tried: { videoId: string; rank: number; score: number }[] = [];
    let verdict = "";
    for (const [rank, c] of song.candidates.entries()) {
      const p = pairs.find(
        (x) => x.song === song.name && x.videoId === c.videoId,
      );
      if (p === undefined) {
        verdict = `undecided (${c.videoId} not cached)`;
        break;
      }
      tried.push({ videoId: c.videoId, rank, score: p.score });
      const choice = chooseCandidate(tried, { exhausted: false });
      if (choice.kind === "accept") {
        verdict = `accept ${choice.videoId}`;
        break;
      }
    }
    if (verdict === "") {
      const choice = chooseCandidate(tried, { exhausted: true });
      verdict =
        choice.kind === "accept"
          ? `accept ${choice.videoId} (end of walk)`
          : `needs-video (best try ${choice.kind === "exhausted" ? (choice.best?.videoId ?? "none") : "none"})`;
    }
    const picked = /accept (\S+)/.exec(verdict)?.[1];
    const what =
      picked === undefined
        ? ""
        : ` → ${song.candidates.find((c) => c.videoId === picked)!.kind}`;
    console.log(
      `  ${song.name.padEnd(14)} ${tried
        .map((t) => `${t.videoId} ${t.score.toFixed(3)}`)
        .join(", ")
        .padEnd(60)} ${verdict}${what}`,
    );
  }
}

// ── Files given on the command line ──────────────────────────────────────────

function runFiles(paths: string[], showChords: boolean, showBars: boolean) {
  const featureSets: BeatFeatures[] = [];
  const tabs: { name: string; tab: UgTab }[] = [];
  for (const path of paths) {
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    const asFeatures = BeatFeaturesSchema.safeParse(json);
    if (asFeatures.success) {
      featureSets.push(asFeatures.data);
      continue;
    }
    tabs.push({ name: basename(path, ".json"), tab: UgTabSchema.parse(json) });
  }
  if (featureSets.length === 0 || tabs.length === 0) {
    throw new Error(
      "usage: calibrate.ts <features.json>... <ug-tab.json>... [--chords | --bars], or calibrate.ts --set [--fetch <origin>]",
    );
  }

  if (featureSets.length > 1 || tabs.length > 1) {
    for (const { name, tab } of tabs) {
      for (const features of featureSets) {
        console.log(
          `${name.padEnd(12)} ${features.videoId.padEnd(12)} ${run(tab, features).summary}`,
        );
      }
    }
    return;
  }
  const { tab } = tabs[0]!;
  const features = featureSets[0]!;
  const { parsed, record, summary } = run(tab, features);
  const T = record.beats.length;
  const timeOf = (beat: number): string => {
    const t = beat < T ? record.beats[beat]!.t : record.durationSec;
    const tenths = Math.round(t * 10);
    return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
  };

  console.log(
    `${tab.artistName} — ${tab.songName} (capo ${tab.capo}) vs ${features.videoId}`,
  );
  console.log(summary);
  if (showBars) {
    console.log(
      "  bar    time   path (corr)         best sheet chord (corr)   best triad (corr)",
    );
    for (const bar of barDiagnostics(parsed, features, record)) {
      console.log(
        `  ${String(bar.bar).padStart(3)}  ${timeOf(bar.startBeat).padStart(7)}   ${`${bar.path} (${bar.pathCorr.toFixed(2)})`.padEnd(20)}${`${bar.bestSheet} (${bar.bestSheetCorr.toFixed(2)})`.padEnd(26)}${bar.bestTriad} (${bar.bestTriadCorr.toFixed(2)})`,
      );
    }
    return;
  }
  let current: string | null = null;
  for (const seg of record.segments) {
    const key =
      seg.kind === "gap"
        ? `gap@${seg.startBeat}`
        : `${seg.section}#${seg.occurrence}`;
    if (key !== current) {
      current = key;
      const label =
        seg.kind === "gap"
          ? "(not in sheet)"
          : `[${seg.section}] ${parsed.sections[seg.section]!.name || "(unnamed)"} #${seg.occurrence + 1}`;
      console.log(`  ${timeOf(seg.startBeat).padStart(7)}  ${label}`);
    }
    if (showChords && seg.kind === "chord") {
      const symbol =
        parsed.sections[seg.section]!.lines[seg.line]!.chords[seg.chord]!
          .symbol;
      console.log(
        `  ${timeOf(seg.startBeat).padStart(7)}      ${String(seg.endBeat - seg.startBeat).padStart(2)}  ${symbol}`,
      );
    }
  }
  console.log(`  ${timeOf(T).padStart(7)}  (end)`);
}

const args = process.argv.slice(2);
if (args.includes("--set")) {
  const at = args.indexOf("--fetch");
  await runSet(at >= 0 ? (args[at + 1] ?? null) : null);
} else {
  runFiles(
    args.filter((a) => !a.startsWith("--")),
    args.includes("--chords"),
    args.includes("--bars"),
  );
}
