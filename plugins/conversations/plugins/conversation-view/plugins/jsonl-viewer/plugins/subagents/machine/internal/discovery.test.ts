import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonlEventsFromChain } from "@plugins/conversations/plugins/transcript-watcher/server";

// The ONE substitution in this plugin's suites, and the only file that makes it:
// which transcript files the conversation owns.
//
// Substituting exactly here is deliberate. `resolveConversationTranscriptPaths`
// is the anchor guard's output (it returns only what `resolveAnchoredChain`
// KEPT), so a test that controls it controls precisely what this plugin is
// allowed to see — which is the property the last suite below is about.
//
// A module substitution is process-wide, so the replacement must provide every
// export the loaded modules actually dereference, and `readJsonlEventsFromChain`
// is copied out of its live binding first: `mock.module` updates a loaded
// module's exports IN PLACE, so reading it back afterwards would hand us the
// substitute instead of the real reader.
let keptPaths: string[] = [];
const realReadJsonlEventsFromChain = readJsonlEventsFromChain;
void mock.module(
  "@plugins/conversations/plugins/transcript-watcher/server",
  () => ({
    readJsonlEventsFromChain: realReadJsonlEventsFromChain,
    resolveConversationTranscriptPaths: () => Promise.resolve(keptPaths),
  }),
);

const {
  listSubagentEntries,
  listSubagents,
  signaturePathsOf,
  subagentWatchDirs,
  findSubagentIn,
  subagentDirs,
  subagentDirOf,
  evictMetaCache,
} = await import("./discovery");
const { scanActivity, evictActivityScan, resolveActivityTargets } =
  await import("./activity-scan");
const { readSubagentTranscript, resolveTranscriptTargets } =
  await import("./transcript-read");

const CONV = "conv-1";

/** The dir-scoped finder, bound to this conversation's anchored directories. */
const find = async (toolUseId: string, requestedName?: string) =>
  findSubagentIn(CONV, await subagentDirs(CONV), { toolUseId, requestedName });
const dirs: string[] = [];

async function newProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subagents-discovery-"));
  dirs.push(dir);
  return dir;
}

/** Lay out `<dir>/<session>.jsonl` plus its `<session>/subagents/` pair files. */
async function writeSession(
  projectsDir: string,
  sessionId: string,
  agents: {
    agentId: string;
    meta?: Record<string, unknown>;
    lines?: string[];
  }[],
): Promise<string> {
  const transcript = join(projectsDir, `${sessionId}.jsonl`);
  await writeFile(transcript, "");
  const subagents = join(projectsDir, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });
  for (const agent of agents) {
    if (agent.meta) {
      await writeFile(
        join(subagents, `agent-${agent.agentId}.meta.json`),
        JSON.stringify(agent.meta),
      );
    }
    if (agent.lines) {
      await writeFile(
        join(subagents, `agent-${agent.agentId}.jsonl`),
        agent.lines.join("\n") + "\n",
      );
    }
  }
  return transcript;
}

const meta = (toolUseId: string, over?: Record<string, unknown>) => ({
  agentType: "Explore",
  description: "Explore the ingest pipeline",
  toolUseId,
  spawnDepth: 1,
  requestShape: "background",
  model: "sonnet",
  ...over,
});

const assistantLine = (text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: "2026-09-20T10:00:00.000Z",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

beforeEach(() => {
  keptPaths = [];
  evictActivityScan(CONV);
  evictMetaCache(CONV);
});

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("subagent discovery", () => {
  test("a sub-agent directory is the session transcript's path, minus .jsonl, plus /subagents", async () => {
    expect(subagentDirOf("/p/sess-a.jsonl")).toBe("/p/sess-a/subagents");

    const projects = await newProjectsDir();
    keptPaths = [join(projects, "sess-a.jsonl")];
    expect(await subagentDirs(CONV)).toEqual([
      join(projects, "sess-a", "subagents"),
    ]);
  });

  test("both files of a pair name one sub-agent, and either one alone discovers it", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        { agentId: "aaa", meta: meta("toolu_1"), lines: [assistantLine("hi")] },
        { agentId: "bbb-with-dashes", meta: meta("toolu_2") },
        { agentId: "ccc", lines: [assistantLine("no meta yet")] },
      ]),
    ];
    const entries = await listSubagentEntries(await subagentDirs(CONV));
    expect(entries.map((e) => e.agentId)).toEqual([
      "aaa",
      "bbb-with-dashes",
      "ccc",
    ]);
  });

  test("a tool-use id resolves to exactly the sub-agent whose meta records it", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "aaa",
          meta: meta("toolu_1"),
          lines: [assistantLine("one")],
        },
        {
          agentId: "bbb",
          meta: meta("toolu_2"),
          lines: [assistantLine("two")],
        },
      ]),
    ];

    const found = await find("toolu_2");
    expect(found.kind).toBe("found");
    if (found.kind !== "found") throw new Error("unreachable");
    expect(found.entry.agentId).toBe("bbb");
    expect(found.entry.transcriptPath).toBe(
      join(projects, "sess-a", "subagents", "agent-bbb.jsonl"),
    );
    // Not-yet-spawned is a "no", never a wrong match.
    expect(await find("toolu_missing")).toEqual({ kind: "none" });
  });

  test("an in-process teammate has no tool-use id, and is still listed", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "mate",
          // A real `taskKind: "in_process_teammate"` meta: no `toolUseId` at all,
          // which is the shape of 306 of the 818 metas on this machine.
          meta: {
            agentType: "subagents-server",
            description: "Server: subagent discovery",
            name: "subagents-server",
            spawnDepth: 0,
            requestShape: "background",
            // A model string is opaque here — the harness writes it and this
            // plugin only carries it to the card, so the fixture deliberately
            // avoids a real `claude-*` CLI flag. Resolving one through the
            // model-provider registry would be worse than pointless: it would
            // assert that the harness writes whatever OUR registry currently
            // resolves to, which is not a relationship that exists.
            model: "opus",
            taskKind: "in_process_teammate",
          },
          lines: [assistantLine("working")],
        },
      ]),
    ];
    const rows = await scanActivity(CONV);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "described",
      toolUseId: undefined,
      agentType: "subagents-server",
    });
  });

  test("a session the anchor DROPPED never has its subagents/ directory scanned", async () => {
    // Two sessions side by side on disk, each with its own sub-agent. Only one is
    // this conversation's: the other resolved to a different projects dir, so
    // `resolveAnchoredChain` classified it `foreign` and
    // `resolveConversationTranscriptPaths` never returned it.
    const projects = await newProjectsDir();
    const mine = await writeSession(projects, "sess-mine", [
      {
        agentId: "mine",
        meta: meta("toolu_mine"),
        lines: [assistantLine("mine")],
      },
    ]);
    await writeSession(projects, "sess-foreign", [
      {
        agentId: "theirs",
        meta: meta("toolu_theirs"),
        lines: [assistantLine("theirs")],
      },
    ]);
    keptPaths = [mine];

    // The derivation is from the KEPT entries and nothing else, so the dropped
    // session's directory is not even a candidate — not filtered out later, never
    // named. Re-resolving from raw session ids is what would reopen this.
    expect(await subagentDirs(CONV)).toEqual([
      join(projects, "sess-mine", "subagents"),
    ]);

    const rows = await scanActivity(CONV);
    expect(rows.map((r) => r.agentId)).toEqual(["mine"]);
    // And the join cannot reach it either: the other agent's tool-use id is a
    // perfectly good id that simply belongs to somebody else.
    expect(await find("toolu_theirs")).toEqual({ kind: "none" });
  });
});

describe("one sub-agent's transcript", () => {
  test("a linked transcript parses with the SAME reader as the main conversation", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "aaa",
          meta: meta("toolu_1"),
          lines: [assistantLine("first"), assistantLine("second")],
        },
      ]),
    ];

    const result = await readSubagentTranscript(CONV, {
      by: "call",
      key: "toolu_1",
    });
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.agentId).toBe("aaa");
    expect(
      result.events.map((e) => (e.kind === "assistant-text" ? e.text : e.kind)),
    ).toEqual(["first", "second"]);
  });

  test("no file yet is `unlinked`, never an empty event list", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    // An empty array here would render as "the sub-agent did nothing"; the arm
    // makes that reading impossible.
    expect(
      await readSubagentTranscript(CONV, { by: "call", key: "toolu_pending" }),
    ).toEqual({
      kind: "unlinked",
    });
  });

  test("while unlinked it watches the DIRECTORY, and narrows to the file once that exists", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    const subagents = join(projects, "sess-a", "subagents");

    // Nothing claims the id yet: routing by a path we do not have would mean the
    // pane never learns the file was created.
    expect(
      await resolveTranscriptTargets(CONV, { by: "call", key: "toolu_1" }),
    ).toEqual({
      paths: [],
      // The `workflows/` level too: a workflow agent's file is born in a run
      // folder below it, and the watcher routes by exact parent directory.
      dirs: [subagents, join(subagents, "workflows")],
    });

    keptPaths = [
      await writeSession(projects, "sess-a", [
        { agentId: "aaa", meta: meta("toolu_1"), lines: [assistantLine("hi")] },
      ]),
    ];
    evictMetaCache(CONV);
    // Identity is now fixed, so a sibling sub-agent's appends stop waking it.
    expect(
      await resolveTranscriptTargets(CONV, { by: "call", key: "toolu_1" }),
    ).toEqual({
      paths: [join(subagents, "agent-aaa.jsonl")],
    });
  });
});

describe("joining a named in-process teammate", () => {
  /** A real teammate meta: a `name`, and no `toolUseId` anywhere in it. */
  const teammate = (name: string) => ({
    agentType: name,
    description: `work of ${name}`,
    name,
    spawnDepth: 0,
    requestShape: "background",
    taskKind: "in_process_teammate",
    teamName: "session-359d3e91",
  });

  test("a teammate joins on the name its parent's Agent call requested", async () => {
    // 307 of the 818 metas on this machine look like this. Its card exists and
    // has an id; the meta simply has no id to match it against, so an id-only
    // join left the card with no duration, no last step, and a dead button.
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "mate",
          meta: teammate("live-probe"),
          lines: [assistantLine("probing")],
        },
      ]),
    ];

    expect(await find("toolu_unknown")).toEqual({ kind: "none" });

    const found = await find("toolu_unknown", "live-probe");
    expect(found.kind).toBe("found");
    if (found.kind !== "found") throw new Error("unreachable");
    expect(found.entry.agentId).toBe("mate");
  });

  test("a name only matches a meta that has no id of its own", async () => {
    // A sub-agent WITH a tool-use id belongs to some other card, even if a name
    // happens to coincide — matching it would steal that card's row.
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "owned",
          meta: { ...teammate("live-probe"), toolUseId: "toolu_owner" },
          lines: [assistantLine("owned")],
        },
      ]),
    ];
    expect(await find("toolu_other", "live-probe")).toEqual({ kind: "none" });
  });

  test("two teammates answering to one name is ambiguous, never a guess", async () => {
    // The harness permits a duplicate name and resolves it "latest wins" — but
    // that rule is about which LIVE teammate a message reaches. A transcript
    // join has no "live", so picking either would put one sub-agent's work under
    // the other's card. (Zero collisions occur in the real corpus.)
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "first",
          meta: teammate("twin"),
          lines: [assistantLine("one")],
        },
        {
          agentId: "second",
          meta: teammate("twin"),
          lines: [assistantLine("two")],
        },
      ]),
    ];

    const found = await find("toolu_unknown", "twin");
    expect(found.kind).toBe("ambiguous");
    if (found.kind !== "ambiguous") throw new Error("unreachable");
    expect(found.reason).toContain("twin");
  });

  test("the row carries the name, so the card can join on it client-side", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "mate",
          meta: teammate("live-probe"),
          lines: [assistantLine("probing")],
        },
      ]),
    ];
    expect(await scanActivity(CONV)).toMatchObject([
      { kind: "described", name: "live-probe", toolUseId: undefined },
    ]);
  });
});

describe("a sub-agent opened by its own id", () => {
  test("reaches a teammate spawned by ANOTHER sub-agent, which no call-keyed lookup can", async () => {
    // Its `Agent` call lives in the parent sub-agent's transcript, not in the
    // conversation's chain — so neither its (absent) tool-use id nor its name
    // joins from here. Its own id names its files directly.
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "nested",
          meta: {
            agentType: "batch",
            description: "Verify batch 1",
            name: "batch1",
            parentAgentId: "lead",
          },
          lines: [assistantLine("checking")],
        },
      ]),
    ];

    expect(
      await readSubagentTranscript(CONV, { by: "call", key: "toolu_lead" }),
    ).toEqual({ kind: "unlinked" });

    const result = await readSubagentTranscript(CONV, {
      by: "agent",
      key: "nested",
    });
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.agentId).toBe("nested");
  });

  test("an unreadable meta does not hide the transcript", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "odd",
          meta: { nonsense: true },
          lines: [assistantLine("x")],
        },
      ]),
    ];
    const result = await readSubagentTranscript(CONV, {
      by: "agent",
      key: "odd",
    });
    expect(result.kind).toBe("linked");
  });

  test("an id nothing on disk carries is `unlinked`", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    expect(
      await readSubagentTranscript(CONV, { by: "agent", key: "ghost" }),
    ).toEqual({ kind: "unlinked" });
  });
});

describe("agents a Workflow run spawned", () => {
  /** A real workflow agent's meta: foreground, a phase, and no tool-use id. */
  const workflowMeta = (label: string) => ({
    agentType: "workflow-subagent",
    description: label,
    workflowPhase: "Census",
    spawnDepth: 1,
    requestShape: "foreground",
    requestNonInteractive: false,
  });

  /** Lay out `<session>/subagents/workflows/<runId>/` with its agents and journal. */
  async function writeRun(
    projects: string,
    sessionId: string,
    runId: string,
    agentIds: string[],
    journal: string[],
  ): Promise<string> {
    const run = join(projects, sessionId, "subagents", "workflows", runId);
    await mkdir(run, { recursive: true });
    for (const agentId of agentIds) {
      await writeFile(
        join(run, `agent-${agentId}.meta.json`),
        JSON.stringify(workflowMeta(`census:${agentId}`)),
      );
      await writeFile(
        join(run, `agent-${agentId}.jsonl`),
        `${assistantLine("working")}\n`,
      );
    }
    await writeFile(
      join(run, "journal.jsonl"),
      journal.map((l) => `${l}\n`).join(""),
    );
    return run;
  }

  test("are found below the root, tagged with their run, beside ordinary sub-agents", async () => {
    const projects = await newProjectsDir();
    keptPaths = [
      await writeSession(projects, "sess-a", [
        {
          agentId: "plain",
          meta: meta("toolu_1"),
          lines: [assistantLine("hi")],
        },
      ]),
    ];
    const run = await writeRun(projects, "sess-a", "wf_a", ["w1", "w2"], []);
    // Not a run folder: ignored rather than walked.
    await mkdir(join(projects, "sess-a", "subagents", "workflows", "scripts"));

    const listing = await listSubagents(await subagentDirs(CONV));
    expect(listing.entries).toEqual([
      expect.objectContaining({ agentId: "plain" }),
      {
        agentId: "w1",
        transcriptPath: join(run, "agent-w1.jsonl"),
        metaPath: join(run, "agent-w1.meta.json"),
        workflowRunId: "wf_a",
      },
      expect.objectContaining({ agentId: "w2", workflowRunId: "wf_a" }),
    ]);
    expect(listing.entries[0]?.workflowRunId).toBeUndefined();
    expect(listing.runs).toEqual([
      { runId: "wf_a", dir: run, journalPath: join(run, "journal.jsonl") },
    ]);
    expect(
      (await listSubagentEntries(await subagentDirs(CONV))).map(
        (e) => e.agentId,
      ),
    ).toEqual(["plain", "w1", "w2"]);
  });

  test("every level of the layout is watched, and the journal is signed", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    const run = await writeRun(projects, "sess-a", "wf_a", ["w1"], []);
    const root = join(projects, "sess-a", "subagents");

    const listing = await listSubagents([root]);
    expect(subagentWatchDirs([root], listing.runs)).toEqual([
      root,
      join(root, "workflows"),
      run,
    ]);
    expect(signaturePathsOf(listing)).toEqual([
      join(run, "agent-w1.meta.json"),
      join(run, "agent-w1.jsonl"),
      join(run, "journal.jsonl"),
    ]);
    expect(await resolveActivityTargets(CONV)).toEqual({
      paths: signaturePathsOf(listing),
      dirs: [root, join(root, "workflows"), run],
    });
  });

  test("a row carries its run, its phase, and whether the journal holds its result", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    await writeRun(
      projects,
      "sess-a",
      "wf_a",
      ["w1", "w2"],
      [
        JSON.stringify({ type: "launched" }),
        JSON.stringify({ type: "started", agentId: "w1", phase: "Census" }),
        JSON.stringify({ type: "result", agentId: "w1", result: { ok: true } }),
      ],
    );

    const rows = await scanActivity(CONV);
    expect(rows.map((r) => [r.agentId, r.workflow])).toEqual([
      ["w1", { runId: "wf_a", reported: true }],
      ["w2", { runId: "wf_a", reported: false }],
    ]);
    expect(rows[0]).toMatchObject({
      kind: "described",
      workflowPhase: "Census",
      toolUseId: undefined,
    });
  });

  test("a workflow agent opens by its own id, like any sub-agent", async () => {
    const projects = await newProjectsDir();
    keptPaths = [await writeSession(projects, "sess-a", [])];
    await writeRun(projects, "sess-a", "wf_a", ["w1"], []);
    const result = await readSubagentTranscript(CONV, {
      by: "agent",
      key: "w1",
    });
    expect(result.kind).toBe("linked");
  });

  test("a run under a session the anchor DROPPED is never walked", async () => {
    const projects = await newProjectsDir();
    const mine = await writeSession(projects, "sess-mine", []);
    await writeSession(projects, "sess-foreign", []);
    await writeRun(projects, "sess-foreign", "wf_theirs", ["theirs"], []);
    keptPaths = [mine];

    expect(await listSubagents(await subagentDirs(CONV))).toEqual({
      entries: [],
      runs: [],
    });
  });
});
