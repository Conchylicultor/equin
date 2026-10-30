import { LEFT_HAND, MINUET, RIGHT_HAND, minuetScript } from "./minuet";
import { FILM_PAGE_IDS } from "./pages";
import { type FilmRun, PRACTICE_FILE } from "./tasks";

// Each run's session, as the turns Claude Code would have logged. The practice
// file's session READS the Piano page through the real `read_page` tool at seed
// (its exact result goes in), and writes the very files the seed puts in the
// workspace — the script, the notes, and (by running the script) the MIDI file.
// The files sit in a folder (`practice/`), so the closing message names them
// as paths the conversation renders as file chips.

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** The workspace files the practice session leaves, relative to its folder. */
export const PRACTICE_FILES = {
  script: "scripts/make-minuet.mjs",
  notes: "practice/notes.md",
  midi: `practice/${MINUET.fileName}`,
} as const;

export const PRACTICE_NOTES = [
  "# Minuet in G, bars 1–8",
  "",
  `The practice file is \`${MINUET.fileName}\`: right hand and left hand on separate tracks, 3/4 at ${MINUET.bpm} bpm. In Sonata, mute a track to practise one hand against the other.`,
  "",
  "## Fingering",
  "",
  "- **Bar 1:** start the D on 5, then 1-2-3-4 for G A B C, so the hand never moves.",
  "- **Bar 3:** E on 5, then put the thumb on C and walk up: C 1, D 2, E 3, F♯ 4.",
  "- **Bar 7:** F♯ on 2 makes G A B G fall under 1-2-3-1 with one thumb tuck.",
  "- **Left hand:** keep the dotted halves held for their full three beats; the first beat of each bar carries the dance.",
  "",
  "## Plan",
  "",
  "1. Hands separately at 72, two clean run-throughs each.",
  "2. Hands together at 72, then 80 (this week's goal).",
  `3. Up to ${MINUET.bpm} once bar 3 is even.`,
  "",
].join("\n");

const NOTE_COUNT = RIGHT_HAND.length + LEFT_HAND.length;

/**
 * The practice session. `workspace` is its folder (the attempt's worktree
 * path); `readPiano` is the `read_page` call the seed ran on the Piano page.
 */
export function practiceTurns(
  workspace: string,
  readPiano: { input: Record<string, unknown>; result: string },
): Turn[] {
  const path = (rel: string) => `${workspace}/${rel}`;
  return [
    { kind: "user", text: PRACTICE_FILE.prompt },
    {
      kind: "assistant",
      text: `I'll read the Piano page (${FILM_PAGE_IDS.piano}) first, for the piece and your teacher's notes.`,
    },
    {
      kind: "tool",
      name: "mcp__equin__read_page",
      input: readPiano.input,
      result: readPiano.result,
    },
    {
      kind: "assistant",
      text: "It's the Minuet in G, BWV Anh. 114: bars 1–8 are the first phrase, in 3/4. I'll write the two hands out note by note in a small script and render the MIDI from it with @tonejs/midi, one track per hand, so you can mute either one in Sonata.",
    },
    {
      kind: "tool",
      name: "Write",
      input: {
        file_path: path(PRACTICE_FILES.script),
        content: minuetScript(),
      },
      result: `File created successfully at: ${path(PRACTICE_FILES.script)}`,
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: `cd ${workspace} && node ${PRACTICE_FILES.script}`,
        description: "Render the practice MIDI file",
      },
      result: `Wrote ${PRACTICE_FILES.midi}: ${NOTE_COUNT} notes, ${MINUET.bars} bars, ${MINUET.bpm} bpm`,
    },
    {
      kind: "assistant",
      text: "The file plays back correctly: both hands line up on every downbeat and bar 8 ends on the held A. Now the fingering notes, mostly for bars 3 and 7, where the right hand has to shift.",
    },
    {
      kind: "tool",
      name: "Write",
      input: { file_path: path(PRACTICE_FILES.notes), content: PRACTICE_NOTES },
      result: `File created successfully at: ${path(PRACTICE_FILES.notes)}`,
    },
    {
      kind: "assistant",
      text: [
        "Your practice file is ready.",
        "",
        `- ${PRACTICE_FILES.midi}: bars 1–8, right and left hand on two tracks, 3/4 at ${MINUET.bpm} bpm. Open it in Sonata to play along or loop a bar.`,
        `- ${PRACTICE_FILES.notes}: fingering for bars 1, 3 and 7, and a three-step plan up to tempo.`,
        "",
        "This week's goal on the Piano page is hands together at 80 bpm. Want me to make a second copy at 80 too?",
      ].join("\n"),
      final: true,
    },
  ];
}

/** A finished run: its prompt and the agent's closing summary. */
export function briefTurns(run: FilmRun): Turn[] {
  return [
    { kind: "user", text: run.prompt },
    {
      kind: "assistant",
      text: `Done: ${run.title.toLowerCase()}. It's pushed, and the app picked it up on the next build.`,
      final: true,
    },
  ];
}

/**
 * Turns as Claude Code's session JSONL: one record per line, each chained to
 * the one before by `parentUuid`, spread evenly from the run's start to its
 * last update. `now` anchors the clock.
 */
export function transcriptJsonl(
  run: FilmRun,
  turns: readonly Turn[],
  workspace: string,
  now: number,
): string {
  const start = now - run.startedAgo;
  const step =
    (run.startedAgo - run.updatedAgo) / Math.max(1, turns.length - 1);
  const lines: unknown[] = [];
  let parent: string | null = null;
  const record = (at: number, type: string, message: unknown) => {
    const uuid = `film-${run.n}-${lines.length + 1}`;
    lines.push({
      type,
      uuid,
      parentUuid: parent,
      sessionId: run.sessionId,
      cwd: workspace,
      timestamp: new Date(at).toISOString(),
      message,
    });
    parent = uuid;
  };
  turns.forEach((turn, i) => {
    const at = start + i * step;
    const msgId = `msg_film_${run.n}_${i + 1}`;
    switch (turn.kind) {
      case "user":
        record(at, "user", { role: "user", content: turn.text });
        return;
      case "assistant":
        record(at, "assistant", {
          id: msgId,
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          ...(turn.final ? { stop_reason: "end_turn" } : {}),
        });
        return;
      case "tool": {
        const toolUseId = `toolu_film_${run.n}_${i + 1}`;
        record(at, "assistant", {
          id: msgId,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: turn.name,
              input: turn.input,
            },
          ],
        });
        record(at + step / 3, "user", {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: turn.result,
            },
          ],
        });
        return;
      }
    }
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
