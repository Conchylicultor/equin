import { CIRCLE_PROTOTYPE } from "@plugins/apps/plugins/website/plugins/promo-film/plugins/circle/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { PIECE } from "./piece";
import { FILM_PAGE_IDS } from "./pages";
import { type FilmRun, GRIEG_RUN } from "./tasks";

// Each run's session, as the turns Claude Code would have logged. The Grieg
// session READS the Piano page and WRITES its note there through the real page
// tools at seed (their exact results go in), fetches the public-domain score
// and MIDI the seed lays down in its folder (the committed fixtures, byte for
// byte), and closes naming both files as paths the conversation renders as
// file chips.

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** A page-tool call the seed ran for real: its input and its result text. */
export interface ToolRun {
  input: Record<string, unknown>;
  result: string;
}

/** What the agent wrote on the Piano page: information it found, not instructions. */
export const GRIEG_NOTE = [
  `**${PIECE.title}** — Grieg, Lyric Pieces Op. 65 No. 6 (1896). He wrote it for his 25th wedding anniversary, at Troldhaugen, his house above the fjord near Bergen.`,
  "- About 6 minutes, in D major: a festive march, a quiet and tender middle section, then the march again, bigger.",
  "- The hard parts are the repeated chords of the opening (light wrists, not arms) and the octaves at the very end.",
  `- Score and MIDI: the Mutopia Project's public-domain edition (Schirmer, 1903), saved in this conversation's folder as \`${PIECE.score.path}\` and \`${PIECE.midi.path}\`.`,
].join("\n");

/**
 * The Grieg session. `workspace` is its folder (the attempt's worktree path);
 * `readPiano` / `notePiano` are the `read_page` / `edit_page` calls the seed
 * ran on the Piano page as this conversation.
 */
export function griegTurns(
  workspace: string,
  readPiano: ToolRun,
  notePiano: ToolRun,
): Turn[] {
  return [
    { kind: "user", text: GRIEG_RUN.prompt },
    {
      kind: "assistant",
      text: `I'll read your Piano page (${FILM_PAGE_IDS.piano}) first, to see where you are.`,
    },
    {
      kind: "tool",
      name: "mcp__equin__read_page",
      input: readPiano.input,
      result: readPiano.result,
    },
    {
      kind: "assistant",
      text: "You're finishing the Chopin nocturne, so this is a good next step. The Mutopia Project has a public-domain edition (Schirmer, 1903) with both a printable score and a MIDI.",
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: `cd ${workspace} && mkdir -p scores music && curl -fsSL -o ${PIECE.score.path} ${PIECE.score.source} && curl -fsSL -o ${PIECE.midi.path} ${PIECE.midi.source}`,
        description: "Fetch the public-domain score and MIDI",
      },
      result: "",
    },
    {
      kind: "assistant",
      text: "Both downloaded: an 8-page A4 score, and a MIDI with the full piece. I rendered the score's first page to check it's the right edition.",
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: `cd ${workspace} && sips -s format png -Z 1800 ${PIECE.score.path} --out ${PIECE.page1.path}`,
        description: "Render the score's first page",
      },
      result: "",
    },
    {
      kind: "assistant",
      text: "It is: Schirmer's 1903 edition, with fingerings. Now the note on your Piano page.",
    },
    {
      kind: "tool",
      name: "mcp__equin__edit_page",
      input: notePiano.input,
      result: notePiano.result,
    },
    {
      kind: "assistant",
      text: [
        `I added a short note about ${PIECE.title} to your Piano page, and saved the edition:`,
        "",
        `- ${PIECE.page1.path}: its first page, to see what you're in for.`,
        `- ${PIECE.score.path}: the whole score, ready to print.`,
        `- ${PIECE.midi.path}: the whole piece. Open it in Sonata to hear it, or to loop the opening slowly.`,
        "",
        `Licence: ${PIECE.licence} — ${PIECE.sourcePage}. Want me to add it to your Repertoire page too?`,
      ].join("\n"),
      final: true,
    },
  ];
}

/** A finished run: its prompt and the agent's closing summary. A waiting one ends on a question. */
export function briefTurns(run: FilmRun): Turn[] {
  return [
    { kind: "user", text: run.prompt },
    run.status === "done"
      ? {
          kind: "assistant",
          text: `Done — ${run.title.charAt(0).toLowerCase()}${run.title.slice(1)} is live. I tested it on your own data, and it's pushed.`,
          final: true,
        }
      : {
          kind: "assistant",
          text: "Before I build it, one question: should it run on its own every week, or only when you ask?",
          final: true,
        },
  ];
}

/** What `prototypes/CLAUDE.md` says, as far as the session read it (an excerpt of the real file). */
const PROTOTYPES_GUIDE = [
  "# Prototypes",
  "",
  "A prototype is a throwaway UI mockup: one flat folder in the Prototypes",
  "app's data dir (`prototypes/<id>/`), with an `index.html`. It is **not in",
  "the repo**: write there directly and commit nothing. That folder is shared by",
  "every worktree and main and shows in the Prototypes app as soon as you save.",
  "No build is needed.",
  "",
  "## Creating one",
  "",
  '- `./equin prototype new "Title"` mints the folder from `_template/` and',
  "  prints its id. Never copy the template by hand, and never name the folder:",
  "  other places refer to the prototype by its id, so the id must never change.",
  "- **One prototype per request.** Asked for several directions? Build all of them",
  "  in one prototype, as an option (`direction: dense | airy | split`).",
  "- Write the id (`proto-…`) in your messages: it renders as a chip that opens",
  "  the prototype.",
  "",
  "## Rules",
  "",
  "- **Design from a blank page.** Don't open other prototypes' folders for inspiration.",
  "- Made-up data only; the page is one self-contained `index.html`.",
  '- Variants go in `<meta name="prototype-option">` tags; the app draws the picker.',
].join("\n");

/**
 * The prototype session the film's "I'd like a P2P messaging app" Wish ran:
 * shaped like the real session that made Circle (read the guide, mint the
 * prototype, write its one file, look at it in a headless browser, fix two
 * things, report). The Write is the prototype's real first version.
 */
export function prototypeTurns(
  prompt: string,
  firstVersionHtml: string,
): Turn[] {
  const folder = prototypesDir.file(CIRCLE_PROTOTYPE);
  const index = `${folder}/index.html`;
  const page = `http://promo-film.localhost:9000/api/prototypes/${CIRCLE_PROTOTYPE}/index.html`;
  return [
    { kind: "user", text: prompt },
    {
      kind: "assistant",
      text: "A messaging app with no server in the middle: your messages go straight from your device to your friends'. This is a new app, so I'll start with a prototype you can click through. First the prototypes guide.",
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: "cat prototypes/CLAUDE.md",
        description: "Read the prototypes guide",
      },
      result: PROTOTYPES_GUIDE,
    },
    {
      kind: "tool",
      name: "Bash",
      input: {
        command: './equin prototype new "Circle — P2P friends"',
        description: "Create the prototype folder",
      },
      result: [
        CIRCLE_PROTOTYPE,
        `  folder: ${folder}`,
        `  url:    http://promo-film.localhost:9000/prototypes/proto/${CIRCLE_PROTOTYPE}`,
      ].join("\n"),
    },
    {
      kind: "assistant",
      text: "The idea is to make it visible where your data is and how it got there: messages that say how they travelled, a map of your circle, and a page of your keys. Writing the page now, with made-up friends.",
    },
    {
      kind: "tool",
      name: "Write",
      input: { file_path: index, content: firstVersionHtml },
      result: `The file ${index} has been updated successfully.`,
    },
    {
      kind: "assistant",
      text: "Written. Opening it in a headless browser to check it renders.",
    },
    {
      kind: "tool",
      name: "mcp__equin__browser_navigate",
      input: { url: page },
      result: JSON.stringify({
        tab: "t1",
        url: page,
        title: "Circle — P2P friends",
      }),
    },
    {
      kind: "tool",
      name: "mcp__equin__browser_console",
      input: { errorsOnly: true },
      result: "(none)",
    },
    {
      kind: "tool",
      name: "mcp__equin__browser_act",
      input: { action: "click", selector: "text=Keys & privacy" },
      result: JSON.stringify({
        tab: "t1",
        url: page,
        clicked: "text=Keys & privacy",
      }),
    },
    {
      kind: "assistant",
      text: "Messages, Circle and Keys & privacy all render with no console errors. Now the same page in the light theme, with no internet and only nearby friends reachable.",
    },
    {
      kind: "tool",
      name: "mcp__equin__browser_navigate",
      input: { url: `${page}?network=nearby&theme=light` },
      result: JSON.stringify({
        tab: "t1",
        url: `${page}?network=nearby&theme=light`,
        title: "Circle — P2P friends",
      }),
    },
    {
      kind: "tool",
      name: "mcp__equin__browser_console",
      input: { errorsOnly: true },
      result: "(none)",
    },
    {
      kind: "assistant",
      text: [
        `Your prototype is ready: ${CIRCLE_PROTOTYPE}`,
        "",
        "Circle is a clickable mockup on made-up data, with no real networking yet. I opened every screen in a headless browser, in both themes and with and without internet, and found no console errors.",
        "",
        "- **Messages:** each message says how it travelled: direct, through a mutual friend (sealed, so they can't read it), or waiting on your device until the friend is reachable.",
        "- **Circle:** a map of your friends with you in the centre. Solid lines are direct connections, dashed through a friend, dotted out of reach.",
        "- **Keys & privacy:** your identity is a key stored on your device. No account, no email, no phone number. It also counts what left your device in the last 24 hours: 0 bytes to servers.",
        "- **Add a friend:** a QR code or a one-time link, then you both read four safety words aloud to check nobody is in between.",
        "",
        "The picker outside the page switches the network between online, nearby and offline. Tell me what to change, or say the word and I'll implement it.",
      ].join("\n"),
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
