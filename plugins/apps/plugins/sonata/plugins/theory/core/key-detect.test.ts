import { describe, expect, it } from "bun:test";
import {
  collectKeyEntries,
  emptyScore,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { inferKeys } from "./key-detect";
import { parseChordSymbol } from "./parse";
import { chordVoicing } from "./voicing";

/**
 * A score whose notes are the given chords, voiced as written. `chords` is
 * `"<symbol>@<start>-<end>"` tokens in beats (4/4, no pickup); a symbol the
 * parser does not know (e.g. "A4") is skipped, as a chord sheet's compiler does.
 */
function chordScore(chords: string): Score {
  const notes: Note[] = [];
  for (const token of chords.trim().split(/\s+/)) {
    const [symbol, range] = token.split("@");
    const [start, end] = range!.split("-").map(Number);
    const data = parseChordSymbol(symbol!);
    if (data === null) continue;
    for (const pitch of chordVoicing(data)) {
      notes.push({
        id: `n${String(notes.length)}`,
        pitch,
        start: start!,
        duration: end! - start!,
        velocity: 80,
        track: "chords",
      });
    }
  }
  return { ...emptyScore(), notes };
}

/** `chords` each held `beats` beats, back to back, starting at beat `from`. */
function progression(symbols: string[], beats: number, from = 0): string {
  return symbols
    .map(
      (s, i) =>
        `${s}@${String(from + i * beats)}-${String(from + (i + 1) * beats)}`,
    )
    .join(" ");
}

const keysOf = (score: Score) =>
  collectKeyEntries(inferKeys(score)).map(
    (e) => `${String(e.beat)} ${e.key.tonic} ${e.key.mode}`,
  );

/**
 * "Là-bas" (Jean-Jacques Goldman) as aligned to its recording: I–vi–IV–V in D
 * throughout, a borrowed ♭VI (B♭) in the bridge, never modulating. Per-bar
 * inference used to split it into D major / G major / B minor / F♯ minor.
 */
const LA_BAS =
  "D@0-98 Bm7@98-100 G@100-102 A4@102-110 A@110-112 Bm7@112-114 D/F#@114-117 G@117-118 A4@118-119 A@119-120 D@120-122 Bm7@122-124 G@124-125 A4@125-126 A@126-128 D@128-131 Bm7@131-132 G@132-133 A4@133-135 A@135-139 Bm7@139-143 D/F#@143-150 G@150-151 A4@151-152 A@152-155 Bm7@155-159 D/F#@159-167 G@167-168 A4@168-169 A@169-171 D@171-176 Bm7@176-179 G@179-181 A4@181-183 A@183-187 D@187-195 Bm7@195-196 G@196-198 A4@198-200 A@200-204 D@204-209 Bm7@209-214 G@214-215 A4@215-217 A@217-221 D@221-223 Bm7@223-226 G@226-227 A4@227-233 A@233-237 Bm7@237-241 D/F#@241-248 G@248-249 A4@249-250 A@250-253 Bm7@253-257 D/F#@257-267 G@267-268 A4@268-269 A@269-271 D@271-283 Bm7@283-284 G@284-285 A4@285-286 A@286-288 D@288-291 Bm7@291-292 G@292-293 A4@293-294 A@294-296 D@296-299 Bm7@299-300 G@300-301 A4@301-302 A@302-304 Bm7@304-306 D/F#@306-308 G@308-309 A4@309-310 A@310-312 Bm7@312-314 D/F#@314-316 G@316-317 A4@317-318 A@318-320 Bb@320-322 Bb/A@322-324 G@324-327 A@327-328 D@328-330 D/C#@330-332 Bm@332-335 A@335-336 Bb@336-338 Bb/A@338-340 G@340-343 A@343-344 D@344-346 D/C#@346-348 Bm@348-350 Bb@350-356 G@356-357 A@357-358 D@358-360 Bm7@360-364 G@364-367 A4@367-368 A@368-372 D@372-377 Bm7@377-381 G@381-382 A4@382-384 A@384-387 Bm7@387-389 D/F#@389-395 G@395-396 A4@396-397 A@397-399 Bm7@399-403 D/F#@403-407 G@407-408 A4@408-409 A@409-412 D@412-414 D@414-416 Bm7@416-420 G@420-422 A4@422-424 A@424-427 D@427-430 Bm7@430-433 G@433-435 A4@435-437 A@437-440 Bm7@440-444 D/F#@444-448 G@448-449 A4@449-450 A@450-452 Bm7@452-455 D/F#@455-458 G@458-459 A4@459-460 A@460-461 D@461-464 Bm7@464-465 G@465-466 A4@466-467 A@467-469 D@469-471 Bm7@471-475 G@475-477 A4@477-479 A@479-483 Bm7@483-485 D/F#@485-493 G@493-494 A4@494-495 A@495-499 Bm7@499-501 D/F#@501-510 G@510-511 A4@511-512 A@512-514 D@514-518 D@518-536 Bm7@536-537 G@537-539 A4@539-541 A@541-545 Bm7@545-547 D/F#@547-571 G@571-572 A4@572-573 A@573-577 D@577-581 Bm7@581-585 G@585-587 A4@587-589 A@589-593 D@593-597 Bm7@597-601 G@601-603 A4@603-605 A@605-609 Bm7@609-611 D/F#@611-618 G@618-619 A4@619-642";

describe("inferKeys", () => {
  it("keeps one key for a diatonic song however its bars lean", () => {
    expect(keysOf(chordScore(LA_BAS))).toEqual(["0 D major"]);
  });

  it("keeps one key through phrases that dwell on the relative minor", () => {
    // Four bars in D, then four on Bm: each Bm phrase alone reads B minor.
    const loop = ["D", "G", "A", "D", "Bm", "Bm", "F#m", "Bm"];
    expect(
      keysOf(chordScore(progression([...loop, ...loop, ...loop], 4))),
    ).toHaveLength(1);
  });

  it("still finds a real modulation, at its phrase", () => {
    const inC = ["C", "F", "G", "C", "Am", "F", "G", "C"];
    const inEb = ["Eb", "Ab", "Bb", "Eb", "Cm", "Ab", "Bb", "Eb"];
    const keys = keysOf(
      chordScore(progression([...inC, ...inC, ...inEb, ...inEb], 4)),
    );
    expect(keys).toEqual(["0 C major", "64 Eb major"]);
  });

  it("never emits two flush regions in the same key", () => {
    const keys = collectKeyEntries(inferKeys(chordScore(LA_BAS)));
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]!.key).not.toEqual(keys[i - 1]!.key);
    }
  });
});
