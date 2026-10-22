import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgentCallNames } from "./agent-calls";

// `scanAgentCallNames` takes its paths, so this needs no module substitution at
// all — it reads real files through the real chain reader. The memo wrapped
// around it is a binding of `transcriptChainSignature` to this function, and
// what it is worth testing for (re-probe on a parent write) is `createSignedMemo`'s
// own pinned behaviour, not this plugin's.

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const line = (content: unknown[]) =>
  `${JSON.stringify({
    type: "assistant",
    uuid: crypto.randomUUID(),
    message: { role: "assistant", content },
  })}\n`;

const agentCall = (id: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input,
});

async function parentWith(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subagents-agent-calls-"));
  dirs.push(dir);
  const path = join(dir, "sess.jsonl");
  await writeFile(path, lines.join(""));
  return path;
}

describe("scanAgentCallNames", () => {
  test("a named Agent call is indexed by its tool-use id", async () => {
    // This is the half of the join that lives in the PARENT: a named teammate's
    // meta has no tool-use id, so the card's id is only tied to it through the
    // name its own Agent call requested.
    const path = await parentWith([
      line([agentCall("toolu_1", { name: "live-probe", prompt: "go" })]),
    ]);
    expect([...(await scanAgentCallNames([path]))]).toEqual([
      ["toolu_1", "live-probe"],
    ]);
  });

  test("an UNnamed Agent call is not indexed — it joins by id and needs nothing here", async () => {
    const path = await parentWith([
      line([agentCall("toolu_1", { subagent_type: "Explore", prompt: "go" })]),
      line([agentCall("toolu_2", { name: "", prompt: "go" })]),
      line([agentCall("toolu_3", { name: 7, prompt: "go" })]),
    ]);
    expect((await scanAgentCallNames([path])).size).toBe(0);
  });

  test("only Agent calls count, so another tool's `name` argument is never a teammate", async () => {
    const path = await parentWith([
      line([
        {
          type: "tool_use",
          id: "toolu_x",
          name: "Write",
          input: { name: "live-probe" },
        },
      ]),
    ]);
    expect((await scanAgentCallNames([path])).size).toBe(0);
  });

  test("several named calls across a chain are all indexed, in id order", async () => {
    const first = await parentWith([
      line([agentCall("toolu_1", { name: "alpha" })]),
    ]);
    const second = await parentWith([
      line([agentCall("toolu_2", { name: "beta" })]),
      line([{ type: "text", text: "thinking" }]),
      line([agentCall("toolu_3", { name: "gamma" })]),
    ]);
    const names = await scanAgentCallNames([first, second]);
    expect(names.get("toolu_1")).toBe("alpha");
    expect(names.get("toolu_2")).toBe("beta");
    expect(names.get("toolu_3")).toBe("gamma");
  });

  test("a transcript with no Agent calls yields an empty index, not a failure", async () => {
    const path = await parentWith([
      line([{ type: "text", text: "just talking" }]),
    ]);
    expect((await scanAgentCallNames([path])).size).toBe(0);
  });
});
