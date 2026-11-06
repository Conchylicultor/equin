import { DEMO_PAGE_IDS } from "./pages";
import { promptOf, type Story } from "./stories";

// The demo's transcripts, written the way Claude Code writes a session: one
// JSON record per line, each turn chained to the one before by `parentUuid`.
// The browser host stores them as text and the real transcript parser reads
// them, so the demo shows exactly what a real session log would.

/** One step of a story's session. */
type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; final?: boolean }
  | { kind: "tool"; name: string; input: unknown; result: string };

/** One page-tool call the practice-timer agent made, as the MCP server saw it. */
export interface PageToolCall {
  /** The tool input, snake_case as the tools take it. */
  input: Record<string, unknown>;
  /** The tool's text result: a read's markdown, a write's JSON report. */
  result: string;
}

/**
 * The practice-timer agent's page work as the seed RAN it (`bin/seed.ts`) through
 * the real page tools (`page/annotations/agent-access`'s `pageTools`) — each
 * call's input and its exact result — so the transcript records a real run
 * and its ids and counts cannot drift from the pages it left.
 */
export interface PageSession {
  /** `read_page` of My equin (the prompt's page). */
  readOrigin: PageToolCall;
  /** `read_page` of the spec My equin links. */
  readSpec: PageToolCall;
  /** `edit_page` on My equin: the plan card and the plan page. */
  edit: PageToolCall;
  /** `write_agent_note` on the card, once the tests passed. */
  note: PageToolCall;
  /** The card and the plan page the edit minted. */
  cardId: string;
  planId: string;
}

/** The page tools as Claude Code names an MCP tool: `mcp__<server>__<tool>`. */
const PAGE_TOOL_PREFIX = "mcp__equin__";

/**
 * A story's session as Claude Code JSONL, its clock ending `story.updatedAgo`
 * before `now`. `session` is the practice-timer agent's page work; the other
 * stories touch no page.
 */
export function transcriptJsonl(
  story: Story,
  now: number,
  session: PageSession,
): string {
  const turns =
    story.key === PRACTICE_TIMER_KEY
      ? practiceTimerTurns(story, session)
      : briefTurns(story);
  // Spread the turns evenly from the start of the session to its last update.
  const start = now - story.startedAgo;
  const step =
    (story.startedAgo - story.updatedAgo) / Math.max(1, turns.length);
  const lines: unknown[] = [];
  let parent: string | null = null;
  const record = (at: number, type: string, message: unknown) => {
    const uuid = `demo-${story.key}-${lines.length + 1}`;
    lines.push({
      type,
      uuid,
      parentUuid: parent,
      timestamp: new Date(at).toISOString(),
      message,
    });
    parent = uuid;
  };
  turns.forEach((turn, i) => {
    const at = start + i * step;
    const msgId = `msg_demo_${story.key}_${i + 1}`;
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
        const toolUseId = `toolu_demo_${story.key}_${i + 1}`;
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

/** Every other story: its prompt and the agent's answer. */
function briefTurns(story: Story): Turn[] {
  return [
    { kind: "user", text: promptOf(story) },
    {
      kind: "assistant",
      text:
        story.reply ??
        (story.status === "done"
          ? `Done: ${story.title.toLowerCase()}.`
          : `On it: I'll ${story.title.toLowerCase()}.`),
      final: story.status !== "working",
    },
  ];
}

const PRACTICE_TIMER_KEY = "practice-timer";

const pageTool = (name: string, call: PageToolCall): Turn => ({
  kind: "tool",
  name: `${PAGE_TOOL_PREFIX}${name}`,
  input: call.input,
  result: call.result,
});

/** Where the agent works: Sonata's play stats, in Demo's own equin. */
const HISTORY = "plugins/apps/plugins/sonata/plugins/playback-history";

/**
 * The open conversation: read the page it was launched from (receiving the
 * page's instructions for agents) and the spec it links, find where Sonata
 * keeps play stats, write the plan on the page, build it, test it, build the
 * preview, report. Its prose names the pages by bare id, which the transcript
 * renders as page chips.
 */
const practiceTimerTurns = (story: Story, session: PageSession): Turn[] => [
  { kind: "user", text: promptOf(story) },
  {
    kind: "assistant",
    text: `This came from the prompt on your My equin page (${DEMO_PAGE_IDS.myEquin}). I'll read it first.`,
  },
  pageTool("read_page", session.readOrigin),
  {
    kind: "assistant",
    text: `Your page asks for short plans, and to be asked before adding a new app; this one extends Sonata, so no new app. It links the practice timer spec (${DEMO_PAGE_IDS.spec}).`,
  },
  pageTool("read_page", session.readSpec),
  {
    kind: "assistant",
    text: "The spec: count only while playing, a week starts on Monday, and this week's total goes next to each song in the library. Let me see what Sonata already records about playing.",
  },
  {
    kind: "tool",
    name: "Grep",
    input: { pattern: "playCount", path: "plugins/apps/plugins/sonata" },
    result: [
      `${HISTORY}/shared/shape.ts`,
      `${HISTORY}/server/internal/routes.ts`,
      `${HISTORY}/web/internal/presentation.tsx`,
      `${HISTORY}/web/components/record-play-observer.tsx`,
    ].join("\n"),
  },
  {
    kind: "tool",
    name: "Read",
    input: { file_path: `${HISTORY}/shared/shape.ts` },
    result: [
      "export const playbackHistoryShape = defineExtensionShape({",
      '  key: "songId",',
      "  fields: {",
      '    playCount: intField({ label: "Plays", default: 0 }),',
      '    lastPlayedAt: nullable(dateField({ label: "Last played" })),',
      "  },",
      "  exposes: {",
      "    parent: songsEntityRef,",
      '    name: "playback",',
      "    fields: { playCount: {}, lastPlayedAt: {} },",
      "  },",
      "});",
    ].join("\n"),
  },
  {
    kind: "assistant",
    text: "Sonata already counts plays per song (`playback-history`), and every field it exposes becomes a library column for free. So the timer is one more field there, fed by the time playback runs. I'll put the plan on your page next to the prompt.",
  },
  pageTool("edit_page", session.edit),
  {
    kind: "tool",
    name: "Edit",
    input: {
      file_path: `${HISTORY}/shared/shape.ts`,
      old_string:
        '    lastPlayedAt: nullable(dateField({ label: "Last played" })),',
      new_string:
        '    lastPlayedAt: nullable(dateField({ label: "Last played" })),\n    practiceThisWeek: durationField({ label: "This week", default: 0 }),',
    },
    result: `The file ${HISTORY}/shared/shape.ts has been updated.`,
  },
  {
    kind: "tool",
    name: "Write",
    input: {
      file_path: `${HISTORY}/server/internal/practice-week.ts`,
      content:
        "/** The Monday that starts the week of `at`, local time. */\nexport function weekStart(at: Date): Date {\n  const d = new Date(at);\n  d.setHours(0, 0, 0, 0);\n  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));\n  return d;\n}\n",
    },
    result: `File created successfully at: ${HISTORY}/server/internal/practice-week.ts`,
  },
  {
    kind: "assistant",
    text: "Now a test that plays, pauses and plays again, so the count cannot drift.",
  },
  {
    kind: "tool",
    name: "Write",
    input: {
      file_path: `${HISTORY}/server/internal/practice-week.test.ts`,
      content:
        'test("a pause does not count", async () => {\n  await play(song, 90_000);\n  await pause(song, 600_000);\n  await play(song, 30_000);\n  expect(await practiceThisWeek(song)).toBe(120_000);\n});\n',
    },
    result: `File created successfully at: ${HISTORY}/server/internal/practice-week.test.ts`,
  },
  {
    kind: "tool",
    name: "Bash",
    input: {
      command: `./equin test ${HISTORY}`,
      description: "Run Sonata's playback-history tests",
    },
    result:
      " ✓ shape.test.ts (2 tests)\n ✓ practice-week.test.ts (4 tests)\n\n 6 pass\n 0 fail",
  },
  {
    kind: "tool",
    name: "Bash",
    input: {
      command: "./equin build",
      description: "Build the preview of this branch",
    },
    result:
      "✓ checks\n✓ migrations: 1 new (sonata_songs_ext_playback.practice_this_week)\n✓ web, server\nDeployed: http://practice-timer.localhost:9000",
  },
  pageTool("write_agent_note", session.note),
  {
    kind: "assistant",
    text: [
      "Done. Sonata's library now shows how long you practised each song this week.",
      "",
      "**What changed.**",
      "- `playback-history` records the time a song's playback runs, beside its play count.",
      "- A **This week** column in the library, empty for a song you haven't practised; weeks start on Monday.",
      "",
      "**Tests.** Play 90 s, pause, play 30 s more: the week shows 2 min. All 6 tests pass.",
      "",
      `**On your page.** The plan is in the card next to the prompt (${session.cardId}) and on its own page (${session.planId}).`,
      "",
      "Try it at http://practice-timer.localhost:9000. Want me to push it?",
    ].join("\n"),
    final: true,
  },
];
