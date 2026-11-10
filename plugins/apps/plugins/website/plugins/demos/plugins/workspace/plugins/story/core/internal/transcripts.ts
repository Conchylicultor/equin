import type { ParsedPrototypeTree } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { DEMO_PAGE_IDS } from "./pages";
import { DEMO_FEATURED_PROTOTYPE } from "./prototypes";
import { DEMO_SONG_ID } from "./songs";
import {
  attemptId,
  promptOf,
  pushSha,
  storyByKey,
  worktreePath,
  type Story,
} from "./stories";

// The demo's transcripts, written the way Claude Code writes a session: one
// JSON record per line, each turn chained to the one before by `parentUuid`.
// The browser host stores them as text and the real transcript parser reads
// them, so the demo shows exactly what a real session log would.
//
// Each story has its own session, in the state the story is in (waiting for
// review, at work, pushed). The page tools ran for real in the seed, so their
// inputs and results are the run's (`PageSession`); every other tool call is
// written in the real tool's input and result shapes — `Read` as `cat -n`,
// `Grep` as its file list, `./equin` as the CLI prints it.

/** One step of a story's session. */
type Turn =
  | {
      kind: "user";
      text: string;
      /** How long the session waited for it, in steps (a person's reply, a background op). */
      waited?: number;
    }
  | { kind: "assistant"; text: string; final?: boolean }
  | {
      kind: "tool";
      name: string;
      input: unknown;
      result: string;
      /** The tool failed (a non-zero exit): the result is flagged `is_error`. */
      error?: boolean;
    }
  /** A tool call still running: its use is written, its result not yet. */
  | { kind: "running"; name: string; input: unknown };

/** One page-tool call an agent made, as the MCP server saw it. */
export interface PageToolCall {
  /** The tool input, snake_case as the tools take it. */
  input: Record<string, unknown>;
  /** The tool's text result: a read's markdown, a write's JSON report. */
  result: string;
}

/**
 * The page work the seed RAN (`bin/seed.ts`) through the real page tools
 * (`page/annotations/agent-access`'s `pageTools`), as the conversation that
 * made each call — each call's input and its exact result — so the
 * transcripts record a real run and their ids and counts cannot drift from the
 * pages left behind.
 */
export interface PageSession {
  /** Practice timer: `read_page` of Piano practice (the prompt's page). */
  readOrigin: PageToolCall;
  /** Practice timer: `read_page` of the spec Piano practice links. */
  readSpec: PageToolCall;
  /** Practice timer: `edit_page` on Piano practice — the plan card and the plan page. */
  edit: PageToolCall;
  /** Practice timer: `write_agent_note` on the card, once the tests passed. */
  note: PageToolCall;
  /** The card and the plan page the edit minted. */
  cardId: string;
  planId: string;
  /** Weekly review: `read_page` of the Journal it writes to. */
  readJournal: PageToolCall;
}

/** What else a session is written from: the demo's prototypes, as the fixture parser reads them. */
export interface SessionContext {
  prototypes: ParsedPrototypeTree;
}

/** The preview a story's agent built, at its worktree's namespace (its attempt id). */
const previewUrl = (story: Story, path = "") =>
  namespaceUrl(asNamespace(attemptId(story)), path);

/** The page tools as Claude Code names an MCP tool: `mcp__<server>__<tool>`. */
const PAGE_TOOL_PREFIX = "mcp__equin__";

/**
 * A story's session as Claude Code JSONL, its clock ending `story.updatedAgo`
 * before `now`.
 */
export function transcriptJsonl(
  story: Story,
  now: number,
  session: PageSession,
  ctx: SessionContext,
): string {
  const script = SESSIONS[story.key];
  if (script === undefined)
    throw new Error(`[demo] no session is written for story "${story.key}"`);
  const turns = script(story, session, ctx);
  // Spread the turns from the start of the session to its last update: one
  // step per tool call or message, longer for a turn the session waited on.
  const weight = (turn: Turn, i: number) =>
    i === 0 ? 0 : turn.kind === "user" ? (turn.waited ?? 1) : 1;
  const steps = turns.reduce((n, t, i) => n + weight(t, i), 0);
  const step = (story.startedAgo - story.updatedAgo) / Math.max(1, steps);
  const times: number[] = [];
  turns.forEach((t, i) =>
    times.push(
      i === 0 ? now - story.startedAgo : times[i - 1]! + weight(t, i) * step,
    ),
  );
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
    const at = times[i]!;
    const msgId = `msg_demo_${story.key}_${i + 1}`;
    const toolUseId = `toolu_demo_${story.key}_${i + 1}`;
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
      case "running":
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
        return;
      case "tool":
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
              ...(turn.error ? { is_error: true } : {}),
            },
          ],
        });
        return;
    }
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ── Tool calls, in the real tools' shapes ──────────────────────────────────

const user = (text: string): Turn => ({ kind: "user", text });
const say = (text: string): Turn => ({ kind: "assistant", text });
const end = (...lines: string[]): Turn => ({
  kind: "assistant",
  text: lines.join("\n"),
  final: true,
});

const pageTool = (name: string, call: PageToolCall): Turn => ({
  kind: "tool",
  name: `${PAGE_TOOL_PREFIX}${name}`,
  input: call.input,
  result: call.result,
});

/** `Read`'s result: the file as `cat -n` prints it, from line `from`. */
const read = (path: string, lines: readonly string[], from = 1): Turn => ({
  kind: "tool",
  name: "Read",
  input:
    from === 1
      ? { file_path: path }
      : { file_path: path, offset: from, limit: lines.length },
  result: lines
    .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
    .join("\n"),
});

/** `Grep` in its default mode: the files that match. */
const grep = (
  pattern: string,
  path: string,
  files: readonly string[],
): Turn => ({
  kind: "tool",
  name: "Grep",
  input: { pattern, path },
  result:
    files.length === 0
      ? "No files found"
      : `Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`,
});

const edit = (path: string, oldString: string, newString: string): Turn => ({
  kind: "tool",
  name: "Edit",
  input: { file_path: path, old_string: oldString, new_string: newString },
  result: `The file ${path} has been updated successfully.`,
});

const write = (path: string, content: string): Turn => ({
  kind: "tool",
  name: "Write",
  input: { file_path: path, content },
  result: `File created successfully at: ${path}`,
});

const bash = (
  command: string,
  description: string,
  result: string,
  error = false,
): Turn => ({
  kind: "tool",
  name: "Bash",
  input: { command, description },
  result: error ? `Exit code 1\n${result}` : result,
  ...(error ? { error: true } : {}),
});

/** Demo's reply, once they had looked: the session waited on them. */
const reply = (text: string): Turn => ({ kind: "user", text, waited: 8 });

/** A background `./equin` op, as Claude Code reports starting one. */
const background = (
  command: string,
  description: string,
  id: string,
): Turn => ({
  kind: "tool",
  name: "Bash",
  input: { command, description, run_in_background: true },
  result: `Command running in background with ID: ${id}. Output is being written to: /tmp/claude/tasks/${id}.output. You will be notified when it completes. To check interim output, use Read on that file path.`,
});

/** One test file of a `./equin test` run: its tests, and which of them failed. */
interface TestFile {
  file: string;
  tests: readonly string[];
  failed?: { test: string; error: readonly string[] };
}

/** `./equin test <path>` as the CLI prints a bun:test run. */
function testRun(path: string, files: readonly TestFile[], ms: number): Turn {
  const total = files.reduce((n, f) => n + f.tests.length, 0);
  const failed = files.filter((f) => f.failed !== undefined).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return bash(
    `./equin test ${path}`,
    "Run the tests",
    [
      "── bun:test ──",
      "bun test v1.4.4 (38afee6c8)",
      "",
      ...files.flatMap((f) => [
        `${f.file}:`,
        ...f.tests.flatMap((t) =>
          f.failed?.test === t
            ? [...f.failed.error, `(fail) ${t}`]
            : [`(pass) ${t}`],
        ),
        "",
      ]),
      ` ${total - failed} pass`,
      ` ${failed} fail`,
      `Ran ${plural(total, "test")} across ${plural(files.length, "file")}. [${ms}ms]`,
      "",
      `bun:test  ${plural(files.length, "file")}   exit ${failed > 0 ? 1 : 0}`,
      "vitest    no jsdom tests under this path",
    ].join("\n"),
    failed > 0,
  );
}

/** `./equin await build` once the build succeeded, as the CLI prints it. */
const buildDone = (story: Story, n: number): Turn =>
  bash(
    "./equin await build",
    "Wait for the build",
    [
      `Awaiting build in ${attemptId(story)} (up to 480s).`,
      "  build: working",
      "build: success",
      `  receipt: ok  buildId build-1792900000-demo${n}  commit ${pushSha(story)}`,
      `  ${previewUrl(story)}`,
      `  log: /home/demo/.equin/worktrees/${attemptId(story)}/runs/build-build-1792900000-demo${n}.log`,
    ].join("\n"),
  );

const pushDone = (story: Story): Turn =>
  bash(
    "./equin await push",
    "Wait for the push",
    [
      `Awaiting push in ${attemptId(story)} (up to 480s).`,
      "  push: working",
      "push: success",
    ].join("\n"),
  );

/** A pushed story's commit, short, as `git log --format=%h` prints it. */
const shortSha = (story: Story) => pushSha(story).slice(0, 10);

// ── The sessions ───────────────────────────────────────────────────────────
//
// Every file a session reads is the real file in this repo (an excerpt, at its
// real line numbers), as Demo's equin held it before the agent's change.

const SONATA = "plugins/apps/plugins/sonata/plugins";

/**
 * The open conversation, waiting for review: read the page it was launched
 * from (receiving the page's instructions for agents) and the spec it links,
 * find where Sonata keeps play stats, write the plan on the page, build it,
 * fail a test on the week boundary and fix it, build the preview, check it on
 * the ii–V–I warm-up, report. Its prose names pages and the song by bare id,
 * which the transcript renders as chips.
 */
function practiceTimer(story: Story, s: PageSession): Turn[] {
  const root = worktreePath(story);
  const history = `${root}/${SONATA}/playback-history`;
  const shape = `${history}/shared/shape.ts`;
  const observer = `${history}/web/components/record-play-observer.tsx`;
  const week = `${history}/shared/practice-week.ts`;
  const pkg = `${SONATA}/playback-history`;
  const weekTests = [
    "a pause does not count [0.19ms]",
    "a week starts on Monday, local time [0.22ms]",
    "a new week starts from zero [0.10ms]",
  ];
  const shapeTest = [
    "exposes playCount and lastPlayedAt on the songs entity, under their persisted ids [0.40ms]",
  ];
  return [
    user(promptOf(story)),
    say(
      `This came from the prompt on your Piano practice page (${DEMO_PAGE_IDS.practice}). I'll read it first.`,
    ),
    pageTool("read_page", s.readOrigin),
    say(
      `Your page asks for short plans and to be asked before adding a new app; this extends Sonata, so no new app. The details are in the spec (${DEMO_PAGE_IDS.spec}).`,
    ),
    pageTool("read_page", s.readSpec),
    say(
      "Four rules: count only while playing, a week starts on Monday, this week's total next to each song, nothing for a song not practised. Let me see what Sonata already records about playing.",
    ),
    grep("playCount", `${root}/${SONATA}`, [
      `${history}/CLAUDE.md`,
      `${history}/server/internal/tables.ts`,
      `${history}/server/internal/routes.ts`,
      `${history}/web/internal/presentation.tsx`,
      shape,
      `${history}/shared/shape.test.ts`,
    ]),
    read(
      shape,
      [
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
      ],
      20,
    ),
    read(
      observer,
      [
        "export function RecordPlayObserver() {",
        "  const fetchEndpoint = useFetchEndpoint();",
        "  const song = useLibrarySongLoad();",
        "  const { isPlaying } = useSession();",
        "  const prevPlaying = useRef(false);",
        "  const recordedLoad = useRef<number | null>(null);",
        "",
        "  useEffect(() => {",
        "    const started = !prevPlaying.current && isPlaying;",
        "    prevPlaying.current = isPlaying;",
        "    if (",
        "      started &&",
        '      song.kind === "library" &&',
        "      recordedLoad.current !== song.load",
        "    ) {",
        "      recordedLoad.current = song.load;",
        "      void fetchEndpoint(recordPlay, { id: song.songId });",
        "    }",
        "  }, [isPlaying, song, fetchEndpoint]);",
        "",
        "  return null;",
        "}",
      ],
      15,
    ),
    say(
      "Sonata already keeps a play count per song (`playback-history`), and every field it exposes is a library column. The observer sees playback start and stop, so it can also time each stretch of playing; a pause ends a stretch. Writing the plan on your page, next to the prompt.",
    ),
    pageTool("edit_page", s.edit),
    edit(
      shape,
      'import { intField } from "@plugins/fields/plugins/int/plugins/config/core";',
      'import { intField } from "@plugins/fields/plugins/int/plugins/config/core";\nimport { durationField } from "@plugins/fields/plugins/duration/plugins/config/core";',
    ),
    edit(
      shape,
      '    lastPlayedAt: nullable(dateField({ label: "Last played" })),\n  },\n  exposes: {\n    parent: songsEntityRef,\n    name: "playback",\n    fields: { playCount: {}, lastPlayedAt: {} },',
      '    lastPlayedAt: nullable(dateField({ label: "Last played" })),\n    practiceThisWeek: durationField({ label: "This week", default: 0 }),\n    practiceWeek: nullable(dateField({ label: "Week of" })),\n  },\n  exposes: {\n    parent: songsEntityRef,\n    name: "playback",\n    fields: { playCount: {}, lastPlayedAt: {}, practiceThisWeek: {} },',
    ),
    write(
      week,
      "/** The Monday that starts the week of `at`. */\nexport function weekStart(at: Date): Date {\n  const d = new Date(at);\n  d.setUTCHours(0, 0, 0, 0);\n  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));\n  return d;\n}\n\n/** The week's total once `ms` more were played at `at`: a new week starts from zero. */\nexport function addPractice(\n  row: { practiceThisWeek: number; practiceWeek: Date | null },\n  ms: number,\n  at: Date,\n) {\n  const week = weekStart(at);\n  const same = row.practiceWeek?.getTime() === week.getTime();\n  return {\n    practiceThisWeek: (same ? row.practiceThisWeek : 0) + ms,\n    practiceWeek: week,\n  };\n}\n",
    ),
    edit(
      `${history}/shared/endpoints.ts`,
      'export const recordPlay = defineEndpoint({\n  route: "POST /api/sonata/songs/:id/play",\n});',
      'export const recordPlay = defineEndpoint({\n  route: "POST /api/sonata/songs/:id/play",\n});\n\n/** Add one stretch of playing (`ms`) to the song\'s practice time this week. */\nexport const recordPractice = defineEndpoint({\n  route: "POST /api/sonata/songs/:id/practice",\n  body: z.object({ ms: z.number().nonnegative() }),\n});',
    ),
    edit(
      observer,
      'import { recordPlay } from "../../shared/endpoints";',
      'import { recordPlay, recordPractice } from "../../shared/endpoints";',
    ),
    edit(
      observer,
      "  const recordedLoad = useRef<number | null>(null);\n\n  useEffect(() => {\n    const started = !prevPlaying.current && isPlaying;\n    prevPlaying.current = isPlaying;",
      '  const recordedLoad = useRef<number | null>(null);\n  const playingSince = useRef<number | null>(null);\n\n  useEffect(() => {\n    const started = !prevPlaying.current && isPlaying;\n    const stopped = prevPlaying.current && !isPlaying;\n    prevPlaying.current = isPlaying;\n    if (started) playingSince.current = performance.now();\n    if (stopped && song.kind === "library" && playingSince.current !== null) {\n      const ms = performance.now() - playingSince.current;\n      playingSince.current = null;\n      void fetchEndpoint(recordPractice, { id: song.songId }, { body: { ms } });\n    }',
    ),
    write(
      `${history}/server/internal/practice-route.ts`,
      'import { eq } from "drizzle-orm";\nimport { db } from "@plugins/database/server";\nimport { implement } from "@plugins/infra/plugins/endpoints/server";\nimport { recordPractice } from "../../shared/endpoints";\nimport { addPractice } from "../../shared/practice-week";\nimport { _songPlaybackExt } from "./tables";\n\nexport const handleRecordPractice = implement(\n  recordPractice,\n  async ({ params, body }) => {\n    await db.transaction(async (tx) => {\n      const [row] = await tx\n        .select()\n        .from(_songPlaybackExt)\n        .where(eq(_songPlaybackExt.songId, params.id))\n        .for("update");\n      const next = addPractice(\n        row ?? { practiceThisWeek: 0, practiceWeek: null },\n        body.ms,\n        new Date(),\n      );\n      await tx\n        .insert(_songPlaybackExt)\n        .values({ songId: params.id, ...next })\n        .onConflictDoUpdate({ target: _songPlaybackExt.songId, set: next });\n    });\n  },\n);\n',
    ),
    say(
      "Now tests for what the spec asks: a pause does not count, and the week turns on Monday.",
    ),
    write(
      `${history}/shared/practice-week.test.ts`,
      'import { expect, test } from "bun:test";\nimport { addPractice } from "./practice-week";\n\nconst at = (iso: string) => new Date(iso);\nconst fresh = { practiceThisWeek: 0, practiceWeek: null };\n\ntest("a pause does not count", () => {\n  let row = addPractice(fresh, 90_000, at("2026-11-04T19:00:00"));\n  row = addPractice(row, 30_000, at("2026-11-04T19:12:00"));\n  expect(row.practiceThisWeek).toBe(120_000);\n});\n\ntest("a week starts on Monday, local time", () => {\n  const sunday = addPractice(fresh, 60_000, at("2026-11-08T23:30:00"));\n  const monday = addPractice(sunday, 45_000, at("2026-11-09T08:00:00"));\n  expect(monday.practiceThisWeek).toBe(45_000);\n});\n\ntest("a new week starts from zero", () => {\n  const last = addPractice(fresh, 60_000, at("2026-11-04T19:00:00"));\n  const next = addPractice(last, 20_000, at("2026-11-11T19:00:00"));\n  expect(next.practiceThisWeek).toBe(20_000);\n});\n',
    ),
    edit(
      `${history}/shared/shape.test.ts`,
      '      "playCount",\n      "lastPlayedAt",\n    ]);',
      '      "playCount",\n      "lastPlayedAt",\n      "practiceThisWeek",\n    ]);',
    ),
    testRun(
      pkg,
      [
        { file: `${pkg}/shared/shape.test.ts`, tests: shapeTest },
        {
          file: `${pkg}/shared/practice-week.test.ts`,
          tests: weekTests,
          failed: {
            test: weekTests[1]!,
            error: [
              "error: expect(received).toBe(expected)",
              "",
              "Expected: 45000",
              "Received: 105000",
              "",
              "      at <anonymous> (practice-week.test.ts:16:36)",
            ],
          },
        },
      ],
      138,
    ),
    say(
      "The week turned at midnight UTC, not at your midnight: a Sunday-night session landed in Monday's week. `weekStart` should use local time.",
    ),
    edit(
      week,
      "  d.setUTCHours(0, 0, 0, 0);\n  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));",
      "  d.setHours(0, 0, 0, 0);\n  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));",
    ),
    testRun(
      pkg,
      [
        { file: `${pkg}/shared/shape.test.ts`, tests: shapeTest },
        { file: `${pkg}/shared/practice-week.test.ts`, tests: weekTests },
      ],
      131,
    ),
    say("All four pass. Building the preview."),
    background("./equin build", "Build and deploy the preview", "bq7m2xk"),
    buildDone(story, 1),
    say(
      `Checking it in the preview on a real song: your ii–V–I warm-up (${DEMO_SONG_ID}), played with a pause in the middle.`,
    ),
    bash(
      `./equin run ${pkg}/e2e/practice-time.ts --song ${DEMO_SONG_ID}`,
      "Play a song in the preview and read the library",
      [
        `target: ${previewUrl(story)}  (this checkout's deploy, build-1792900000-demo1, built 1m ago)`,
        "",
        "=== playback-history: practice time ===",
        "ok    the song opens: ii–V–I warm-up",
        "ok    playback runs for 40 s",
        "ok    paused for 30 s: the count does not move",
        "ok    playback runs for 20 s more",
        "ok    the library's This week column reads 1 min",
        "ok    a song not played this week shows nothing",
        "",
        "PASS  6/6",
      ].join("\n"),
    ),
    pageTool("write_agent_note", s.note),
    end(
      "Ready for review. Sonata's library now shows how long you practised each song this week.",
      "",
      "**What changed**",
      "- `playback-history` times each stretch of playback, beside its play count; a pause ends a stretch.",
      "- A **This week** column in the library, empty for a song you haven't practised; the week starts on Monday, your time.",
      "",
      "**Checked**",
      "- The tests pass. One caught a real bug on the way: the week turned at midnight UTC, not at yours.",
      `- In the preview, on your ii–V–I warm-up (${DEMO_SONG_ID}): 40 s, a 30 s pause, 20 s more reads 1 min.`,
      "",
      `The plan is in the card next to your prompt (${s.cardId}) and on its own page (${s.planId}).`,
      "",
      `Preview: ${previewUrl(story)}. Want me to push it?`,
    ),
  ];
}

/** The recipes prototype's inlined photos: fetched by the agent, never written by hand. */
const PHOTOS_FILE = "photos.js";

/**
 * A new app starts as a prototype: the agent mints one, writes its files, and
 * hands it over; Demo asks for changes, each one of the prototype's committed
 * versions (`data/prototypes/`, parsed by the fixture's own parser), and it
 * waits for the next. The files written, each request and each edit are the
 * versions' own, so the session cannot drift from the prototype it shows.
 */
function recipes(story: Story, _s: PageSession, ctx: SessionContext): Turn[] {
  const id = DEMO_FEATURED_PROTOTYPE;
  const dir = `/home/demo/.equin/apps/prototypes/${id}`;
  const folder = ctx.prototypes.prototypes.find((p) => p.id === id);
  if (folder === undefined)
    throw new Error(
      `[demo] the recipes session's prototype ${id} is not in data/`,
    );
  const [first, ...steps] = folder.versions;
  if (first === undefined || steps.length === 0)
    throw new Error(
      `[demo] prototype ${id} needs a first version and at least one step`,
    );
  const answers = [
    `Done (${id}, v1): the recipes you pick for the week sit in a bar at the bottom, with their photos and one tap to the shopping list.`,
    `v2 is ready (${id}): the accent option now has plum and ocean beside terracotta and olive.\n\nNext would be the real app. That's a new app in your equin, so I'm asking first: build it from this prototype?`,
  ];
  if (answers.length !== steps.length)
    throw new Error(
      `[demo] prototype ${id} has ${steps.length} steps; the recipes session answers ${answers.length}`,
    );
  // The photos are inlined into a script the page loads, so the prototype
  // needs no photo host; the agent fetches them rather than writing them.
  const { [PHOTOS_FILE]: photos, ...written } = first.files;
  if (photos === undefined)
    throw new Error(`[demo] prototype ${id} has no ${PHOTOS_FILE}`);
  const photoIds = [...photos.matchAll(/^ {2}"(photo-[^"]+)":/gm)].map(
    (m) => m[1]!,
  );
  return [
    user(promptOf(story)),
    say(
      "A new app starts as a prototype, so you can see it before anything is built. I'll do the whole loop in one page: the recipes as photo cards, a recipe's detail with servings you can scale, and the shopping list built from the week's picks — merged, scaled and grouped by aisle.",
    ),
    bash(
      './equin prototype new "Family Recipes"',
      "Create the prototype",
      [
        id,
        `  folder: ${dir}`,
        `  url:    ${previewUrl(story, `/prototypes/proto/${id}`)}`,
      ].join("\n"),
    ),
    bash(
      [
        `cd ${dir} && for p in ${photoIds.join(" ")}; do`,
        `  curl -s "https://images.unsplash.com/$p?w=480&h=360&fit=crop&q=50" | base64 | sed "s|.*|  \\"$p\\": \\"data:image/jpeg;base64,&\\",|"`,
        `done | (echo 'window.PHOTOS = {'; cat; echo '};') > ${PHOTOS_FILE} && wc -c ${PHOTOS_FILE}`,
      ].join("\n"),
      "Fetch the recipe photos and inline them",
      `  ${photos.length} ${PHOTOS_FILE}`,
    ),
    // The page first, then anything else it loads.
    ...Object.entries(written)
      .sort(
        ([a], [b]) => Number(b === "index.html") - Number(a === "index.html"),
      )
      .map(([file, text]) => write(`${dir}/${file}`, text)),
    end(
      `Your prototype is ready: ${id}.`,
      "",
      "- **Recipes**: a photo card per recipe, filtered by who it's from or by this week; + puts one on this week.",
      "- **A recipe**: its story, ingredients scaled to the servings you set, the method, and photos you can add.",
      "- **Shopping list**: the week's ingredients merged and grouped by aisle; tick them off, add extras, copy it.",
      "- One option at the top: the **accent** colour (terracotta or olive).",
      "",
      "Everything you do stays in this browser. What would you change?",
    ),
    ...steps.flatMap((version, i) => {
      const before = (i === 0 ? first : steps[i - 1]!).files;
      return [
        reply(version.subject),
        ...Object.entries(version.changed).map(([file, text]) => {
          const was = before[file];
          return was === undefined
            ? write(`${dir}/${file}`, text)
            : editOf(`${dir}/${file}`, was, text);
        }),
        { kind: "assistant", text: answers[i]!, final: true } satisfies Turn,
      ];
    }),
  ];
}

/**
 * The `Edit` an agent makes to turn `was` into `now`: the lines that differ,
 * with one unchanged line before them when the change only adds lines.
 */
function editOf(path: string, was: string, now: string): Turn {
  const a = was.split("\n");
  const b = now.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  // A pure insertion keeps one unchanged line to anchor on: the one before
  // it, or, at the top of the file, the one after it.
  const pure = a.length - tail === head;
  const from = pure && head > 0 ? head - 1 : head;
  const keep = pure && head === 0 ? tail - 1 : tail;
  const oldString = a.slice(from, a.length - keep).join("\n");
  if (was.split(oldString).length !== 2)
    throw new Error(
      `[demo] the edit of ${path} does not anchor on a unique old_string`,
    );
  return edit(path, oldString, b.slice(from, b.length - keep).join("\n"));
}

/**
 * The Weekly review agent, at work on a sidequest: last week's pushes, then
 * the Journal it writes to (a real read), then a look at one push — still
 * running.
 */
function weeklyReview(story: Story, s: PageSession): Turn[] {
  const pin = storyByKey("pin-songs");
  const wish = storyByKey("wish-shortcut");
  return [
    user(promptOf(story)),
    say("Starting with what landed on main in the last seven days."),
    bash(
      'git log main --since="7 days ago" --format="%h %s"',
      "List last week's pushes",
      [`${shortSha(pin)} ${pin.title}`, `${shortSha(wish)} ${wish.title}`].join(
        "\n",
      ),
    ),
    say(
      `Two pushes. Now your Journal (${DEMO_PAGE_IDS.journal}), to write the review the way you write there.`,
    ),
    pageTool("read_page", s.readJournal),
    say(
      "Short dated lines, newest first. I'll add a Monday entry with one line per push, in your words rather than the commit's. Checking what the pin push changed first.",
    ),
    {
      kind: "running",
      name: "Bash",
      input: {
        command: `git show --stat ${shortSha(pin)}`,
        description: "See what the pinned-songs push changed",
      },
    },
  ];
}

/** A design question before building: tasks have no date to place them on. */
function calendar(story: Story): Turn[] {
  const root = worktreePath(story);
  const tables = `${root}/plugins/tasks/plugins/tasks-core/server/internal/tables.ts`;
  return [
    user(promptOf(story)),
    say(
      "First, which dates a task carries, to know where it would sit on the month.",
    ),
    grep("dueAt|due_at", `${root}/plugins/tasks`, []),
    read(
      tables,
      [
        "    groupId: {",
        "      references: {",
        "        column: (): AnyPgColumn => tasksEntity.table.id,",
        '        onDelete: "set null",',
        "      },",
        "    },",
        "    titleAuto: { default: true },",
        "    createdAt: { default: defaultNow() },",
        "    updatedAt: { default: defaultNow() },",
        "  },",
      ],
      82,
    ),
    say("And whether a month grid already exists to reuse."),
    grep("export function Calendar", `${root}/plugins/primitives`, [
      `${root}/plugins/primitives/plugins/date-picker/web/components/calendar.tsx`,
    ]),
    end(
      "The date picker's `Calendar` already draws a month, so the view itself is small. Before I build it, one choice. A task has the day it was filed and the day it last changed, but no due date. Where should a task sit on the month?",
      "",
      "- <go>On the day it was filed</go>: nothing new to fill in, but it shows when you asked, not when it's due.",
      "- <go>On a due date I set</go>: a date field in the task detail; tasks without one wait in a list beside the month.",
    ),
  ];
}

/**
 * The Small wishes agent's pick, pushed once Demo said so: a pinned flag on
 * songs, built the way playback-history adds its play count (an extension
 * of the songs entity whose exposed fields every song list reads).
 */
function pinSongs(story: Story): Turn[] {
  const root = worktreePath(story);
  const dir = `${root}/${SONATA}/pinned-songs`;
  const pkg = `${SONATA}/pinned-songs`;
  return [
    user(promptOf(story)),
    say(
      "Small and contained: a pin on each song, and pinned songs first in the library. Sonata's play count is a good model for a per-song flag.",
    ),
    read(
      `${root}/${SONATA}/playback-history/shared/shape.ts`,
      [
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
      ],
      20,
    ),
    say(
      "An extension of the songs entity, exposed, becomes a field every song list can sort by. The same for a pin, in its own plugin.",
    ),
    write(
      `${dir}/shared/shape.ts`,
      'import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";\nimport { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";\nimport { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";\n\n/** Whether the user pinned a song to the top of the library. */\nexport const pinnedSongShape = defineExtensionShape({\n  key: "songId",\n  fields: {\n    pinned: boolField({ label: "Pinned", default: false }),\n  },\n  exposes: {\n    parent: songsEntityRef,\n    name: "pin",\n    fields: { pinned: {} },\n  },\n});\n',
    ),
    write(
      `${dir}/shared/shape.test.ts`,
      'import { expect, test } from "bun:test";\nimport { pinnedSongShape } from "./shape";\n\ntest("exposes pinned on the songs entity, false for a song never pinned", () => {\n  const { exposure } = pinnedSongShape;\n  expect(exposure.parent.name).toBe("sonata_songs");\n  expect(exposure.fields.pinned).toMatchObject({ label: "Pinned", absent: false });\n});\n',
    ),
    testRun(
      pkg,
      [
        {
          file: `${pkg}/shared/shape.test.ts`,
          tests: [
            "exposes pinned on the songs entity, false for a song never pinned [0.36ms]",
          ],
        },
      ],
      88,
    ),
    background("./equin build", "Build and deploy the preview", "bf3k8wd"),
    buildDone(story, 2),
    end(
      "Ready: each song has a pin, and the library lists pinned songs first. The test passes.",
      "",
      `Preview: ${previewUrl(story)}. Push it?`,
    ),
    reply("Looks good, push it"),
    background(
      `./equin push -m "${story.title}"`,
      "Merge into main",
      "bp1w6zr",
    ),
    pushDone(story),
    end("Pushed: pinned songs are in your equin."),
  ];
}

/** A wish filed by hand, pushed: a shortcut bound the way the hints bind theirs. */
function wishShortcut(story: Story): Turn[] {
  const root = worktreePath(story);
  const wish = `${root}/plugins/wish/web/index.ts`;
  return [
    user(promptOf(story)),
    say(
      "The Wish popover already opens from code (`openWish`); it needs a shortcut bound to it. How do other plugins bind one?",
    ),
    grep("defineShortcut\\(", `${root}/plugins`, [
      `${root}/plugins/hints/web/index.ts`,
    ]),
    read(
      `${root}/plugins/hints/web/index.ts`,
      [
        "    defineShortcut({",
        '      id: "hints.tour-end",',
        '      keys: "Escape",',
        '      label: "End the tour",',
        '      group: "Hints",',
      ],
      45,
    ),
    read(wish, [
      'import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";',
      'import { ActionBar } from "@plugins/shell/plugins/action-bar/web";',
      'import { WishButton } from "./components/wish-button";',
      'import { WishSlots } from "./slots";',
    ]),
    edit(
      wish,
      'import { WishSlots } from "./slots";',
      'import { WishSlots } from "./slots";\nimport { defineShortcut } from "@plugins/primitives/plugins/shortcuts/web";\nimport { openWish } from "./internal/open-store";',
    ),
    edit(
      wish,
      "      component: WishButton,\n    }),",
      '      component: WishButton,\n    }),\n    defineShortcut({\n      id: "wish.open",\n      keys: "mod+shift+w",\n      label: "Make a wish",\n      group: "Wish",\n      handler: () => openWish(),\n    }),',
    ),
    background("./equin build", "Build and deploy the preview", "bw9d4tn"),
    buildDone(story, 3),
    end(
      "Ready: ⌘⇧W opens the Wish popover from any app, with the page you are on attached. It is listed under Wish in the shortcuts sheet.",
      "",
      `Preview: ${previewUrl(story)}. Push it?`,
    ),
    reply("Ship it"),
    background(
      `./equin push -m "${story.title}"`,
      "Merge into main",
      "bs5h2qc",
    ),
    pushDone(story),
    end("Pushed: ⌘⇧W files a wish from anywhere now."),
  ];
}

/** Every story's session, by story key — a story without one fails the seed. */
const SESSIONS: Record<
  string,
  (story: Story, s: PageSession, ctx: SessionContext) => Turn[]
> = {
  "practice-timer": practiceTimer,
  recipes,
  "weekly-review": weeklyReview,
  calendar,
  "pin-songs": pinSongs,
  "wish-shortcut": wishShortcut,
};
