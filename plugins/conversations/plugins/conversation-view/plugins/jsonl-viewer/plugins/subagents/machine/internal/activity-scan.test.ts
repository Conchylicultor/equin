import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Count the bounded tail reads. This is the whole growth story: the index is
// re-read on every append by any sub-agent, so a scan that re-read every file
// would be O(all sub-agents × their whole length) per line written.
//
// Capture the REAL function into a const before mocking. `mock.module` updates
// an already-loaded module's exports IN PLACE, so a wrapper that reached back
// through the namespace object would resolve to the mock and call itself
// forever. Same shape as `watcher.test.ts`'s `realReadChain`, same reason.
const { readTail: realReadTail, TAIL_WINDOW_BYTES } =
  await import("./tail-read");
const readPaths: string[] = [];
void mock.module("./tail-read", () => ({
  TAIL_WINDOW_BYTES,
  readTail: (path: string, size: number) => {
    readPaths.push(path);
    return realReadTail(path, size);
  },
}));

// No module substitution beyond that: `scanActivityIn` takes the directories it
// may read, so this suite hands it a temp dir instead of mocking the chain
// resolver out from under it. Which directories a CONVERSATION owns is
// `subagentDirs`' job, and `discovery.test.ts` pins that separately.
const { scanActivityIn, evictActivityScan } = await import("./activity-scan");

const SCOPE = "scan-scope";
const dirs: string[] = [];
let subagentsDir = "";

/** The newest meta shape: every field the harness writes today. */
const fullMeta = (agentId: string) =>
  JSON.stringify({
    agentType: "Explore",
    description: `work of ${agentId}`,
    toolUseId: `toolu_${agentId}`,
    spawnDepth: 1,
    requestShape: "background",
    requestNonInteractive: true,
    model: "sonnet",
  });

/**
 * The OLDEST meta shape still on disk — three fields and nothing else. Seven of
 * the 818 real meta files on this machine look exactly like this, and a schema
 * that required `model` / `requestShape` / `spawnDepth` threw on every one of
 * them, taking the whole conversation's list down with it.
 */
const minimalMeta = (agentId: string) =>
  JSON.stringify({
    agentType: "Explore",
    description: `old work of ${agentId}`,
    toolUseId: `toolu_${agentId}`,
  });

const assistant = (content: unknown[]) =>
  `${JSON.stringify({
    type: "assistant",
    uuid: crypto.randomUUID(),
    isSidechain: true,
    message: { role: "assistant", content },
  })}\n`;

beforeEach(async () => {
  evictActivityScan(SCOPE);
  readPaths.length = 0;
  subagentsDir = await mkdtemp(join(tmpdir(), "subagents-scan-"));
  dirs.push(subagentsDir);
});

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function addAgent(
  agentId: string,
  text: string,
  meta: (id: string) => string = fullMeta,
): Promise<void> {
  await writeFile(
    join(subagentsDir, `agent-${agentId}.meta.json`),
    meta(agentId),
  );
  await writeFile(
    join(subagentsDir, `agent-${agentId}.jsonl`),
    assistant([{ type: "text", text }]),
  );
}

const scan = () => scanActivityIn(SCOPE, [subagentsDir]);

describe("scanActivityIn", () => {
  test("one row per sub-agent, carrying its meta and its last step", async () => {
    await addAgent("aaa", "thinking about it");
    const rows = await scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "described",
      agentId: "aaa",
      toolUseId: "toolu_aaa",
      agentType: "Explore",
      description: "work of aaa",
      requestShape: "background",
      spawnDepth: 1,
      model: "sonnet",
      lastStep: { kind: "text", preview: "thinking about it" },
    });
  });

  test("an OLD three-field meta renders beside a current one, and neither hides the other", async () => {
    // The regression this pins: the meta format has grown field by field, and a
    // conversation's directory holds sub-agents from every version it ever ran
    // under. Requiring a field the older half never had made ONE ancient
    // sub-agent throw inside the loader and blank every card in the conversation.
    await addAgent("new", "current", fullMeta);
    await addAgent("old", "ancient", minimalMeta);

    const rows = await scan();
    expect(rows).toHaveLength(2);

    const old = rows.find((r) => r.agentId === "old")!;
    expect(old.kind).toBe("described");
    if (old.kind !== "described") throw new Error("unreachable");
    expect(old.description).toBe("old work of old");
    expect(old.toolUseId).toBe("toolu_old");
    // Absent means the harness never recorded it — NOT a default to render.
    expect(old.model).toBeUndefined();
    expect(old.requestShape).toBeUndefined();
    expect(old.spawnDepth).toBeUndefined();
    // And the modern one beside it is untouched.
    expect(rows.find((r) => r.agentId === "new")).toMatchObject({
      kind: "described",
      model: "sonnet",
      requestShape: "background",
    });
  });

  test("a meta nothing can make sense of costs ONE row, never the list", async () => {
    await addAgent("good", "fine");
    await writeFile(
      join(subagentsDir, "agent-broken.meta.json"),
      "{not json at all",
    );
    await writeFile(
      join(subagentsDir, "agent-broken.jsonl"),
      assistant([
        { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
      ]),
    );

    const rows = await scan();
    expect(rows).toHaveLength(2);

    const broken = rows.find((r) => r.agentId === "broken")!;
    expect(broken.kind).toBe("undescribed");
    if (broken.kind !== "undescribed") throw new Error("unreachable");
    expect(broken.reason).toBe("not valid JSON");
    // Everything the filesystem knows survives, so the card still has something
    // true to show.
    expect(broken.lastStep).toEqual({
      kind: "tool",
      toolName: "Bash",
      preview: "echo hi",
    });
    // And the sub-agent next to it renders exactly as before.
    expect(rows.find((r) => r.agentId === "good")).toMatchObject({
      kind: "described",
      description: "work of good",
    });
  });

  test("a requestShape this build has never heard of is undescribed, not guessed at", async () => {
    await writeFile(
      join(subagentsDir, "agent-future.meta.json"),
      JSON.stringify({
        agentType: "Explore",
        description: "from a later Claude Code",
        requestShape: "detached",
      }),
    );
    const rows = await scan();
    expect(rows[0]!.kind).toBe("undescribed");
    // The reason names the field, so a person reading it knows what changed.
    expect((rows[0] as { reason: string }).reason).toContain("requestShape");
  });

  test("an unreadable meta is retried, so a torn read of a file being created heals", async () => {
    const metaPath = join(subagentsDir, "agent-torn.meta.json");
    // Exactly what a read landing mid-write looks like.
    await writeFile(metaPath, '{"agentType":"Expl');
    expect((await scan())[0]!.kind).toBe("undescribed");

    await writeFile(metaPath, fullMeta("torn"));
    expect((await scan())[0]).toMatchObject({
      kind: "described",
      description: "work of torn",
    });
  });

  test("a sub-agent whose meta has not landed gets no row — not a row named 'unknown'", async () => {
    await writeFile(
      join(subagentsDir, "agent-early.jsonl"),
      assistant([{ type: "text", text: "already writing" }]),
    );
    expect(await scan()).toEqual([]);
  });

  test("a change costs ONE tail read: only the file that moved is re-read", async () => {
    await addAgent("aaa", "a");
    await addAgent("bbb", "b");
    await addAgent("ccc", "c");

    await scan();
    expect(readPaths).toHaveLength(3);

    // Nothing moved: no file is read at all.
    await scan();
    expect(readPaths).toHaveLength(3);

    // One sub-agent appends. Exactly one tail read, and it is that file's.
    await appendFile(
      join(subagentsDir, "agent-bbb.jsonl"),
      assistant([
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/x/watcher.ts" },
        },
      ]),
    );
    const rows = await scan();
    expect(readPaths).toHaveLength(4);
    expect(readPaths.at(-1)).toBe(join(subagentsDir, "agent-bbb.jsonl"));
    expect(rows.find((r) => r.agentId === "bbb")!.lastStep).toEqual({
      kind: "tool",
      toolName: "Read",
      preview: "watcher.ts",
    });
    // And the untouched rows still carry the step their last read produced.
    expect(rows.find((r) => r.agentId === "aaa")!.lastStep).toEqual({
      kind: "text",
      preview: "a",
    });
  });

  test("a sub-agent that has not written a line yet reports its start as its last activity", async () => {
    await writeFile(join(subagentsDir, "agent-new.meta.json"), fullMeta("new"));
    const rows = await scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastStep).toBeNull();
    expect(rows[0]!.lastActivityAt).toBe(rows[0]!.startedAt);
    expect(rows[0]!.turnEnded).toBe(false);
    expect(readPaths).toHaveLength(0);
  });
});
