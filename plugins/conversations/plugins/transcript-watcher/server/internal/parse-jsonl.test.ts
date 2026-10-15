import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeChainLines,
  readJsonlEvents,
  readJsonlEventsFromChain,
} from "./parse-jsonl";

// readJsonlEvents only takes a file path (it reads via Bun.file), so each
// fixture is written to a temp JSONL file and parsed end-to-end. This also
// exercises the real activeLineUuids branch-filter, which is the point: side
// leaves only survive because that filter keeps everything but rewinds.

const TS = "2026-06-30T00:00:00.000Z";
const tmpFiles: string[] = [];

async function writeFixture(lines: Record<string, unknown>[]): Promise<string> {
  const path = join(tmpdir(), `parse-jsonl-test-${crypto.randomUUID()}.jsonl`);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  tmpFiles.push(path);
  return path;
}

// A minimal user line carrying string content, so the spine has real turns.
const userLine = (
  uuid: string,
  parentUuid: string | null,
  text: string,
  at: string = TS,
) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at,
  message: { role: "user", content: text },
});

const assistantLine = (
  uuid: string,
  parentUuid: string | null,
  text: string,
  at: string = TS,
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const hookErrorLine = (uuid: string, parentUuid: string | null) => ({
  type: "attachment",
  uuid,
  parentUuid,
  timestamp: TS,
  attachment: {
    type: "hook_non_blocking_error",
    hookName: "PreToolUse:Bash",
    stderr: "Module not found: guard.ts",
  },
});

const hookSuccessLine = (uuid: string, parentUuid: string | null) => ({
  type: "attachment",
  uuid,
  parentUuid,
  timestamp: TS,
  attachment: {
    type: "hook_success",
    hookName: "PreToolUse:Edit",
    exitCode: 0,
    stdout: "{}",
  },
});

const hookContextLine = (uuid: string, parentUuid: string | null) => ({
  type: "attachment",
  uuid,
  parentUuid,
  timestamp: TS,
  attachment: {
    type: "hook_additional_context",
    hookName: "PreToolUse:Edit",
    content: ["keep CLAUDE.md terse"],
  },
});

afterAll(async () => {
  await Promise.all(tmpFiles.map((p) => Bun.file(p).delete()));
});

const toolUseLine = (uuid: string, parentUuid: string, name: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: TS,
  message: {
    id: `msg-${uuid}`,
    role: "assistant",
    content: [{ type: "tool_use", id: `tu-${uuid}`, name, input: {} }],
  },
});

const toolResultLine = (uuid: string, parentUuid: string, of: string) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: TS,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: `tu-${of}`, content: `result ${of}` },
    ],
  },
});

const toolCallsOf = (events: Awaited<ReturnType<typeof readJsonlEvents>>) =>
  events.flatMap((e) =>
    e.kind === "tool-call"
      ? [{ id: e.toolUseId, result: e.result?.content }]
      : [],
  );

describe("readJsonlEvents — side leaves off the live conversation", () => {
  test("a parallel tool batch pairs every call with its result", async () => {
    // The shape Claude Code writes: tool_use lines chained, each result parented
    // on its OWN tool_use, the turn continuing from the last result. Only the
    // last result is on the newest-leaf path; the rest are side leaves.
    const path = await writeFixture([
      userLine("root", null, "file three tasks"),
      toolUseLine("t1", "root", "add_task"),
      toolUseLine("t2", "t1", "add_task"),
      toolUseLine("t3", "t2", "add_task"),
      toolResultLine("r1", "t1", "t1"),
      toolResultLine("r2", "t2", "t2"),
      toolResultLine("r3", "t3", "t3"),
      assistantLine("done", "r3", "filed"),
    ]);

    expect(toolCallsOf(await readJsonlEvents(path))).toEqual([
      { id: "tu-t1", result: "result t1" },
      { id: "tu-t2", result: "result t2" },
      { id: "tu-t3", result: "result t3" },
    ]);
  });

  test("results landing out of order still keep every call", async () => {
    // Result 2 lands first and the turn continues from result 1, leaving the
    // second tool_use itself off the newest-leaf path.
    const path = await writeFixture([
      userLine("root", null, "run two commands"),
      toolUseLine("t1", "root", "Bash"),
      toolUseLine("t2", "t1", "Bash"),
      toolResultLine("r2", "t2", "t2"),
      toolResultLine("r1", "t1", "t1"),
      assistantLine("done", "r1", "both ran"),
    ]);

    expect(toolCallsOf(await readJsonlEvents(path))).toEqual([
      { id: "tu-t1", result: "result t1" },
      { id: "tu-t2", result: "result t2" },
    ]);
  });

  test("a dead-end hook error off a live node is kept", async () => {
    const path = await writeFixture([
      userLine("root", null, "hello"),
      assistantLine("spine1", "root", "working"),
      hookErrorLine("att", "root"),
      userLine("spine2", "spine1", "continue"),
    ]);

    const attachments = (await readJsonlEvents(path)).filter(
      (e) => e.kind === "attachment",
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      subtype: "hook_non_blocking_error",
    });
  });

  test("a hook's context chained off its hook_success is kept", async () => {
    // Claude threads the context a hook injected as a CHILD of the hook_success
    // it came from, both hanging off the live node as a dead-end branch.
    const path = await writeFixture([
      userLine("root", null, "hello"),
      assistantLine("spine1", "root", "working"),
      hookSuccessLine("hook", "spine1"),
      hookContextLine("ctx", "hook"),
      userLine("spine2", "spine1", "continue"),
    ]);

    const attachments = (await readJsonlEvents(path)).filter(
      (e) => e.kind === "attachment",
    );
    expect(
      attachments.map((a) => a.kind === "attachment" && a.subtype),
    ).toEqual(["hook_success", "hook_additional_context"]);
  });

  test("side leaves of a rewound branch are dropped with it", async () => {
    // `old` was resubmitted as `new` (same parent): everything under `old`,
    // its tool call, result and hook chain included, is gone.
    const path = await writeFixture([
      userLine("root", null, "hello"),
      assistantLine("a0", "root", "hi"),
      userLine("old", "a0", "first try"),
      toolUseLine("t1", "old", "Bash"),
      hookSuccessLine("hook", "t1"),
      hookContextLine("ctx", "hook"),
      toolResultLine("r1", "t1", "t1"),
      userLine("new", "a0", "second try"),
    ]);

    const events = await readJsonlEvents(path);
    expect(events.filter((e) => e.kind === "attachment")).toHaveLength(0);
    expect(toolCallsOf(events)).toEqual([]);
    expect(textsOf(events, "user-text")).toEqual(["hello", "second try"]);
  });
});

describe("readJsonlEvents — tool_reference results", () => {
  test("a tool search's tool_reference blocks survive as toolReferences", async () => {
    // A ToolSearch result carries no text: its content is tool_reference
    // blocks, which extractText drops. The names must still reach the row.
    const path = await writeFixture([
      userLine("root", null, "load the tools"),
      toolUseLine("t1", "root", "ToolSearch"),
      {
        type: "user",
        uuid: "r1",
        parentUuid: "t1",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-t1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "mcp__equin__add_task",
                },
                { type: "tool_reference", tool_name: "WebFetch" },
              ],
            },
          ],
        },
      },
    ]);

    const call = (await readJsonlEvents(path)).find(
      (e) => e.kind === "tool-call",
    );
    expect(call?.kind === "tool-call" ? call.result : undefined).toEqual({
      at: TS,
      content: "",
      toolReferences: ["mcp__equin__add_task", "WebFetch"],
    });
  });

  test("a plain text result carries no toolReferences", async () => {
    const path = await writeFixture([
      userLine("root", null, "run it"),
      toolUseLine("t1", "root", "Bash"),
      toolResultLine("r1", "t1", "t1"),
    ]);

    const call = (await readJsonlEvents(path)).find(
      (e) => e.kind === "tool-call",
    );
    expect(
      call?.kind === "tool-call" ? call.result?.toolReferences : "not a call",
    ).toBeUndefined();
  });
});

describe("readJsonlEvents — AskUserQuestion answers", () => {
  const answeredLine = (toolUseResult: unknown) => ({
    type: "user",
    uuid: "r1",
    parentUuid: "t1",
    timestamp: TS,
    toolUseResult,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-t1",
          // The CLI's prose for the model — its wording is not the answer.
          content:
            'User has answered your questions: "Which?"="Explain". Read the answers carefully — and follow what they actually say.',
        },
      ],
    },
  });

  test("the line's toolUseResult rides on the result as questionAnswer", async () => {
    const path = await writeFixture([
      userLine("root", null, "ask me"),
      toolUseLine("t1", "root", "AskUserQuestion"),
      answeredLine({
        questions: [{ question: "Which?", header: "H", options: [] }],
        answers: { "Which?": "Explain" },
        annotations: { "Which?": { notes: "a note" } },
      }),
    ]);

    const call = (await readJsonlEvents(path)).find(
      (e) => e.kind === "tool-call",
    );
    expect(
      call?.kind === "tool-call" ? call.result?.questionAnswer : "not a call",
    ).toEqual({
      answers: { "Which?": "Explain" },
      annotations: { "Which?": { notes: "a note" } },
    });
  });

  test("an answer record the schema rejects throws", async () => {
    const path = await writeFixture([
      userLine("root", null, "ask me"),
      toolUseLine("t1", "root", "AskUserQuestion"),
      answeredLine({ questions: [], answers: { "Which?": 3 } }),
    ]);
    let threw = false;
    try {
      await readJsonlEvents(path);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("another tool's result carries no questionAnswer", async () => {
    const path = await writeFixture([
      userLine("root", null, "run it"),
      toolUseLine("t1", "root", "Bash"),
      toolResultLine("r1", "t1", "t1"),
    ]);

    const call = (await readJsonlEvents(path)).find(
      (e) => e.kind === "tool-call",
    );
    expect(
      call?.kind === "tool-call" ? call.result?.questionAnswer : "not a call",
    ).toBeUndefined();
  });
});

describe("readJsonlEvents — unparseable timestamp", () => {
  test("a line whose timestamp is not a parseable date emits no event", async () => {
    const path = await writeFixture([
      userLine("root", null, "hello", "not-a-date"),
    ]);

    const events = await readJsonlEvents(path);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session chains: one conversation spread over several Claude session files.
// ---------------------------------------------------------------------------

const T1 = "2026-06-30T01:00:00.000Z";
const T2 = "2026-06-30T02:00:00.000Z";
const T3 = "2026-06-30T03:00:00.000Z";
const T4 = "2026-06-30T04:00:00.000Z";

// A forked session rewrites the copied lines' timestamps; keep them distinct so
// "first wins" is observable rather than coincidental.
const FORK_T1 = "2026-06-30T09:00:00.000Z";
const FORK_T2 = "2026-06-30T09:30:00.000Z";

const summaryLine = (text: string, at: string) => ({
  type: "summary",
  timestamp: at,
  summary: text,
});

const chainFile = (path: string, lines: Record<string, unknown>[]) => ({
  path,
  raw: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
});

const uuidsOf = (lines: Record<string, unknown>[]) => lines.map((l) => l.uuid);
const stampsOf = (lines: Record<string, unknown>[]) =>
  lines.map((l) => l.timestamp);
const textsOf = (events: { kind: string }[], kind: string) =>
  events
    .filter((e): e is { kind: string; text: string } => e.kind === kind)
    .map((e) => e.text);

describe("mergeChainLines", () => {
  test("superset fork — shared uuids appear once, with the ancestor's timestamps", () => {
    // B is what Claude writes when it forks A: every one of A's lines is copied
    // verbatim (same uuid, restamped), then B continues past the copy.
    const a = chainFile("a.jsonl", [
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
    ]);
    const b = chainFile("b.jsonl", [
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("u3", "u2", "continue", T3),
    ]);

    const merged = mergeChainLines([a, b]);
    expect(uuidsOf(merged)).toEqual(["u1", "u2", "u3"]);
    expect(stampsOf(merged)).toEqual([T1, T2, T3]);
  });

  test("disjoint fresh session — nothing is deduped, chain order is preserved", () => {
    const a = chainFile("a.jsonl", [userLine("u1", null, "hello", T1)]);
    const c = chainFile("c.jsonl", [
      userLine("c1", null, "fresh start", T3),
      assistantLine("c2", "c1", "ok", T4),
    ]);

    expect(uuidsOf(mergeChainLines([a, c]))).toEqual(["u1", "c1", "c2"]);
  });

  test("midpoint fork — the ancestor's post-fork lines survive the merge itself", () => {
    // The merge is uuid-dedup only; dropping `a2` is the branch filter's doing,
    // which runs one level up. Asserted end-to-end below.
    const a = chainFile("a.jsonl", [
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
      userLine("a2", "u2", "ancestor kept talking", T3),
    ]);
    const b = chainFile("b.jsonl", [
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("b1", "u2", "fork kept talking", T4),
    ]);

    expect(uuidsOf(mergeChainLines([a, b]))).toEqual(["u1", "u2", "a2", "b1"]);
  });

  test("uuid-less metadata lines survive from every file, even when identical", () => {
    // Dedup is keyed on uuid; metadata markers carry none, so each file's copy
    // is kept. They are not in the forest, so the branch filter never sees them.
    const a = chainFile("a.jsonl", [
      { type: "ai-title", title: "shared" },
      userLine("u1", null, "hello", T1),
    ]);
    const b = chainFile("b.jsonl", [
      { type: "ai-title", title: "shared" },
      userLine("u1", null, "hello", FORK_T1),
      { type: "permission-mode", mode: "default" },
    ]);

    const merged = mergeChainLines([a, b]);
    expect(merged.map((l) => l.type)).toEqual([
      "ai-title",
      "user",
      "ai-title",
      "permission-mode",
    ]);
  });

  test("a malformed line is skipped; the rest of the file still parses", () => {
    const files = [
      { path: "a.jsonl", raw: `{"uuid":"u1"}\nnot json\n{"uuid":"u2"}\n` },
    ];
    expect(uuidsOf(mergeChainLines(files))).toEqual(["u1", "u2"]);
  });
});

describe("readJsonlEventsFromChain", () => {
  test("superset fork — the copied spine renders once, at the ancestor's times", async () => {
    const a = await writeFixture([
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
    ]);
    const b = await writeFixture([
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("u3", "u2", "continue", T3),
    ]);

    const events = await readJsonlEventsFromChain([a, b]);
    expect(textsOf(events, "user-text")).toEqual(["hello", "continue"]);
    expect(textsOf(events, "assistant-text")).toEqual(["hi"]);
    expect(events[0]).toMatchObject({ kind: "user-text", at: T1 });
    expect(events[1]).toMatchObject({ kind: "assistant-text", at: T2 });
  });

  test("disjoint fresh session — both root trees keep their leaf→root path", async () => {
    const a = await writeFixture([
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
    ]);
    const c = await writeFixture([
      userLine("c1", null, "fresh start", T3),
      assistantLine("c2", "c1", "ok", T4),
    ]);

    const events = await readJsonlEventsFromChain([a, c]);
    expect(textsOf(events, "user-text")).toEqual(["hello", "fresh start"]);
    expect(textsOf(events, "assistant-text")).toEqual(["hi", "ok"]);
  });

  test("midpoint fork — the ancestor's post-fork lines are dropped as an abandoned branch", async () => {
    // Pins the documented caveat: after the merge, the prompts `a2` and `b1`
    // are siblings under `u2` in ONE tree, and activeLineUuids drops the
    // earlier as rewound. This is the one place the chain merge can hide a line.
    const a = await writeFixture([
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
      userLine("a2", "u2", "ancestor kept talking", T3),
    ]);
    const b = await writeFixture([
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("b1", "u2", "fork kept talking", T4),
    ]);

    const events = await readJsonlEventsFromChain([a, b]);
    expect(textsOf(events, "user-text")).toEqual([
      "hello",
      "fork kept talking",
    ]);
  });

  test("uuid-less metadata lines from every file reach the event stream", async () => {
    const a = await writeFixture([
      userLine("u1", null, "hello", T1),
      summaryLine("first segment", T2),
    ]);
    const b = await writeFixture([
      userLine("u1", null, "hello", FORK_T1),
      summaryLine("second segment", T3),
    ]);

    const events = await readJsonlEventsFromChain([a, b]);
    expect(textsOf(events, "summary")).toEqual([
      "first segment",
      "second segment",
    ]);
  });

  test("a chain entry with no transcript on disk yet is skipped", async () => {
    const a = await writeFixture([userLine("u1", null, "hello", T1)]);
    const missing = join(
      tmpdir(),
      `parse-jsonl-absent-${crypto.randomUUID()}.jsonl`,
    );

    const events = await readJsonlEventsFromChain([a, missing]);
    expect(textsOf(events, "user-text")).toEqual(["hello"]);
  });

  test("a length-1 chain is identical to readJsonlEvents", async () => {
    // A rewind plus a side leaf: the branch filter, the side-leaf handling and
    // the event order must all be untouched.
    const path = await writeFixture([
      userLine("root", null, "hello", T1),
      assistantLine("spine1", "root", "working", T2),
      userLine("abandoned", "spine1", "abandoned attempt", T2),
      hookErrorLine("att", "root"),
      userLine("spine2", "spine1", "continue", T3),
    ]);

    const single = await readJsonlEvents(path);
    expect(await readJsonlEventsFromChain([path])).toEqual(single);
    expect(textsOf(single, "user-text")).toEqual(["hello", "continue"]);
    expect(textsOf(single, "assistant-text")).toEqual(["working"]);
    expect(single.filter((e) => e.kind === "attachment")).toHaveLength(1);
  });
});

describe("readJsonlEvents — context compaction", () => {
  const boundary = (uuid: string) => ({
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    uuid,
    parentUuid: null,
    timestamp: TS,
    compactMetadata: { trigger: "auto", preTokens: 318372, postTokens: 10167 },
  });
  const summaryLine = (uuid: string, parentUuid: string) => ({
    ...userLine(
      uuid,
      parentUuid,
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n## Done\n\n- the thing\n\nIf you need specific details from before compaction, read the full transcript at: /x.jsonl\nContinue the conversation from where it left off without asking the user any further questions.",
    ),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  const attachmentLine = (
    uuid: string,
    parentUuid: string,
    attachment: Record<string, unknown>,
  ) => ({ type: "attachment", uuid, parentUuid, timestamp: TS, attachment });

  test("boundary, summary and re-read files fold into one compaction event", async () => {
    const path = await writeFixture([
      userLine("u1", null, "first"),
      boundary("b"),
      summaryLine("s", "b"),
      attachmentLine("f1", "s", {
        type: "file",
        filename: "/w/out.txt",
        content: {
          type: "text",
          file: { filePath: "/w/out.txt", numLines: 11 },
        },
      }),
      attachmentLine("f2", "f1", {
        type: "compact_file_reference",
        filename: "/w/plan.md",
        displayPath: "plan.md",
      }),
      attachmentLine("k", "f2", { type: "invoked_skills", skills: [] }),
      assistantLine("a", "k", "carrying on"),
      attachmentLine("f3", "a", {
        type: "file",
        filename: "/w/later.txt",
        content: {
          type: "text",
          file: { filePath: "/w/later.txt", numLines: 2 },
        },
      }),
    ]);
    const events = await readJsonlEvents(path);
    expect(events.map((e) => e.kind)).toEqual([
      "user-text",
      "compaction",
      "attachment",
      "assistant-text",
      "attachment",
    ]);
    expect(events[1]).toEqual({
      kind: "compaction",
      at: TS,
      trigger: "auto",
      preTokens: 318372,
      postTokens: 10167,
      summary: "## Done\n\n- the thing",
      files: [
        { path: "/w/out.txt", lines: 11 },
        { path: "/w/plan.md", lines: undefined },
      ],
    });
  });

  test("a summary is never a user message, even without a boundary", async () => {
    const path = await writeFixture([
      userLine("u1", null, "first"),
      summaryLine("s", "u1"),
    ]);
    const events = await readJsonlEvents(path);
    expect(events.map((e) => e.kind)).toEqual(["user-text", "compaction"]);
  });
});

describe("readJsonlEvents — file-history-delta checkpoints", () => {
  const delta = (trackingPath: string, backupFileName: string | null) => ({
    type: "file-history-delta",
    messageId: "m1",
    snapshotMessageId: "s1",
    trackingPath,
    backup: {
      backupFileName,
      version: 1,
      backupTime: TS,
      realParentDir: "/wt/att-1/research",
    },
    timestamp: TS,
  });

  test("emits a file-checkpoint with the absolute path and whether the file is new", async () => {
    const path = await writeFixture([
      delta("research/plan.md", null),
      delta("research/old.md", "53f20fc5b62ee2aa@v1"),
    ]);
    expect(await readJsonlEvents(path)).toEqual([
      {
        kind: "file-checkpoint",
        at: TS,
        path: "/wt/att-1/research/plan.md",
        created: true,
      },
      {
        kind: "file-checkpoint",
        at: TS,
        path: "/wt/att-1/research/old.md",
        created: false,
      },
    ]);
  });

  test("keeps an absolute trackingPath (a file outside the worktree) as is", async () => {
    const path = await writeFixture([
      {
        ...delta("/tmp/scratch/data.js", null),
        backup: { backupFileName: null, realParentDir: "/tmp/scratch" },
      },
    ]);
    expect(await readJsonlEvents(path)).toEqual([
      {
        kind: "file-checkpoint",
        at: TS,
        path: "/tmp/scratch/data.js",
        created: true,
      },
    ]);
  });

  test("falls back to unknown when the shape is not understood", async () => {
    const path = await writeFixture([
      { type: "file-history-delta", trackingPath: "x.md", timestamp: TS },
    ]);
    expect((await readJsonlEvents(path)).map((e) => e.kind)).toEqual([
      "unknown",
    ]);
  });
});

describe("api-request lines", () => {
  const apiRequest = (
    at: string,
    over: { effort?: string; querySource?: string; params?: unknown } = {},
  ) => ({
    type: "api-request",
    timestamp: at,
    querySource: over.querySource ?? "repl_main_thread",
    shapeHash: "shape-1",
    params: over.params ?? {
      model: "model-a",
      betas: ["a", "b"],
      max_tokens: 128000,
      thinking: { type: "adaptive" },
      output_config: { effort: over.effort ?? "medium" },
      safeguards: [
        {
          type: "dangerous_tool_use",
          classifier_context: { permission_mode: "auto" },
        },
      ],
    },
  });

  test("keeps a caller's first call and the ones that changed its settings, counting the identical calls into them", async () => {
    const path = await writeFixture([
      apiRequest("2026-06-30T00:00:01.000Z"),
      apiRequest("2026-06-30T00:00:02.000Z"),
      apiRequest("2026-06-30T00:00:03.000Z", { effort: "high" }),
      apiRequest("2026-06-30T00:00:04.000Z", { effort: "high" }),
    ]);
    const events = (await readJsonlEvents(path)).filter(
      (e) => e.kind === "api-request",
    );
    expect(
      events.map((e) => [
        e.at,
        e.previous?.effort ?? null,
        e.config.effort,
        e.calls,
      ]),
    ).toEqual([
      ["2026-06-30T00:00:01.000Z", null, "medium", 2],
      ["2026-06-30T00:00:03.000Z", "medium", "high", 2],
    ]);
    expect(events[0]!.config).toEqual({
      model: "model-a",
      effort: "medium",
      thinking: "adaptive",
      maxTokens: 128000,
      permissionMode: "auto",
      betas: ["a", "b"],
      shapeHash: "shape-1",
    });
  });

  test("compares each caller against its own previous call", async () => {
    const path = await writeFixture([
      apiRequest("2026-06-30T00:00:01.000Z"),
      apiRequest("2026-06-30T00:00:02.000Z", {
        querySource: "compact",
        effort: "low",
      }),
      apiRequest("2026-06-30T00:00:03.000Z"),
    ]);
    const events = (await readJsonlEvents(path)).filter(
      (e) => e.kind === "api-request",
    );
    expect(events.map((e) => [e.source, e.previous === null])).toEqual([
      ["repl_main_thread", true],
      ["compact", true],
    ]);
  });

  test("a line without params.model stays unknown", async () => {
    const path = await writeFixture([
      apiRequest("2026-06-30T00:00:01.000Z", { params: { betas: [] } }),
    ]);
    const events = await readJsonlEvents(path);
    expect(events.map((e) => e.kind)).toEqual(["unknown"]);
  });
});

describe("api-request-shape lines", () => {
  const shapeLine = (
    at: string,
    tools: string[],
    system: string[] = ["You are Claude Code."],
  ) => ({
    type: "api-request-shape",
    timestamp: at,
    shapeHash: `hash-${tools.join(",")}`,
    shape: {
      system: system.map((text) => ({ type: "text", text })),
      tools: tools.map((name) => ({
        name,
        description: `${name} does things`,
        input_schema: { type: "object" },
      })),
    },
  });

  test("lifts tool names and system text, diffing each shape against the one before", async () => {
    const path = await writeFixture([
      shapeLine("2026-06-30T00:00:01.000Z", ["Bash", "Read"]),
      shapeLine("2026-06-30T00:00:02.000Z", ["Bash", "Read", "mcp__x__q"]),
      shapeLine("2026-06-30T00:00:03.000Z", ["Bash", "mcp__x__q"], ["Other."]),
    ]);
    const events = (await readJsonlEvents(path)).filter(
      (e) => e.kind === "request-shape",
    );
    expect(events.map((e) => [e.shape.tools, e.change])).toEqual([
      [["Bash", "Read"], null],
      [
        ["Bash", "Read", "mcp__x__q"],
        { toolsAdded: ["mcp__x__q"], toolsRemoved: [], systemChanged: false },
      ],
      [
        ["Bash", "mcp__x__q"],
        { toolsAdded: [], toolsRemoved: ["Read"], systemChanged: true },
      ],
    ]);
    expect(events[0]!.shape.system).toEqual(["You are Claude Code."]);
  });

  test("a shape that changes nothing this reads is not a row", async () => {
    const path = await writeFixture([
      shapeLine("2026-06-30T00:00:01.000Z", ["Bash"]),
      shapeLine("2026-06-30T00:00:02.000Z", ["Bash"]),
    ]);
    const events = await readJsonlEvents(path);
    expect(events.map((e) => e.kind)).toEqual(["request-shape"]);
  });

  test("a line without shape.tools stays unknown", async () => {
    const path = await writeFixture([
      { type: "api-request-shape", timestamp: "2026-06-30T00:00:01.000Z" },
    ]);
    const events = await readJsonlEvents(path);
    expect(events.map((e) => e.kind)).toEqual(["unknown"]);
  });
});
