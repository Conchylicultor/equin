import { PIECE } from "./piece";
import { FILM_PAGE_IDS } from "./pages";
import { type FilmRun, PRACTICE_FILE } from "./tasks";

// Each run's session, as the turns Claude Code would have logged. The practice
// session READS the Piano page through the real `read_page` tool at seed (its
// exact result goes in), fetches the public-domain MIDI the seed lays down in
// the workspace (the committed fixture, byte for byte), and writes the notes.
// The files sit in a folder (`practice/`), so the closing message names them
// as paths the conversation renders as file chips.

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** The workspace files the practice session leaves, relative to its folder. */
export const PRACTICE_FILES = {
  notes: "practice/notes.md",
  midi: `practice/${PIECE.fileName}`,
} as const;

export const PRACTICE_NOTES = [
  `# ${PIECE.title}, practice notes`,
  "",
  `The score is \`${PIECE.fileName}\`, the Mutopia Project's public-domain edition: right hand and left hand on separate tracks. In Sonata, mute a track to practise one hand against the other, and slow the tempo down from 100%.`,
  "",
  "## The hard parts",
  "",
  "- **Bars 1–4:** the left hand's sextuplets alone first; the arpeggio is the whole engine of the piece.",
  "- **Bars 5–12:** four right-hand sixteenths against six left-hand notes. Clap 4 against 6 before playing it; the hands only meet on each beat.",
  "- **Bars 13–24:** keep the thumb light on the repeated G♯s; the melody is the top note of each group.",
  "- **Largo (bar 43):** the famous melody. Sing it first, then let the left hand breathe under it.",
  "",
  "## Plan",
  "",
  "1. Hands separately at 60%, bars 1–12.",
  "2. Hands together at 60%, then 75% (this week's goal).",
  "3. The Largo section next week.",
  "",
].join("\n");

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
      text: `It's the ${PIECE.full}. The Mutopia Project has a public-domain edition of it with the two hands on separate tracks, so I'll fetch that rather than write it out.`,
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: `mkdir -p ${workspace}/practice && curl -fsSL -o ${PRACTICE_FILES.midi} ${PIECE.source}`,
        description: "Fetch the public-domain MIDI",
      },
      result: "",
    },
    {
      kind: "assistant",
      text: "It plays back cleanly: two tracks, upper and lower, the full piece. Now the notes, mostly for the opening (4 against 6) and the Largo.",
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
        "Your practice material is ready.",
        "",
        `- ${PRACTICE_FILES.midi}: the whole ${PIECE.title}, right and left hand on two tracks (public domain, ${PIECE.sourcePage}). Open it in Sonata to play along or loop a passage.`,
        `- ${PRACTICE_FILES.notes}: what to practise in bars 1–24 and the Largo, and a three-step plan up to tempo.`,
        "",
        "This week's goal on the Piano page is hands together at 75%. Want me to make a slower practice copy too?",
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
