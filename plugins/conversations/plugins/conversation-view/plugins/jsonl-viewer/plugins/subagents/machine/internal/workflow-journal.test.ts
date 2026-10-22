import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evictWorkflowJournals,
  readReportedAgents,
  readWorkflowReports,
} from "./workflow-journal";

const SCOPE = "journal-scope";
const dirs: string[] = [];
let journal = "";

/** Real journal lines, trimmed: a `result` embeds the agent's whole output. */
const launched = `${JSON.stringify({ type: "launched" })}\n`;
const started = (agentId: string) =>
  `${JSON.stringify({ type: "started", key: `v2:${agentId}`, agentId, label: agentId, phase: "Census" })}\n`;
const result = (agentId: string, output: unknown = { resources: [] }) =>
  `${JSON.stringify({ type: "result", key: `v2:${agentId}`, agentId, result: output })}\n`;

beforeEach(async () => {
  evictWorkflowJournals(SCOPE);
  const dir = await mkdtemp(join(tmpdir(), "subagents-journal-"));
  dirs.push(dir);
  journal = join(dir, "journal.jsonl");
});

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const reported = async () => [...(await readReportedAgents(SCOPE, journal))];

describe("workflow journal", () => {
  test("no journal yet: nobody has reported, and that is not a failure", async () => {
    expect(await reported()).toEqual([]);
  });

  test("only `result` lines report; `launched` and `started` say nothing about completion", async () => {
    await writeFile(journal, launched + started("a1") + started("a2"));
    expect(await reported()).toEqual([]);
    await appendFile(journal, result("a1"));
    expect(await reported()).toEqual(["a1"]);
  });

  test("reads incrementally: appended lines are folded into what was already read", async () => {
    await writeFile(journal, launched + result("a1"));
    expect(await reported()).toEqual(["a1"]);
    await appendFile(journal, started("a2") + result("a2"));
    expect(await reported()).toEqual(["a1", "a2"]);
  });

  test("a partial trailing line waits until it is complete", async () => {
    const line = result("a1", {
      note: "é — multi-byte text straddling the cut",
    });
    const bytes = Buffer.from(line);
    // Cut INSIDE the multi-byte character, mid-line.
    const cut = bytes.indexOf(Buffer.from("é")) + 1;
    await writeFile(
      journal,
      Buffer.concat([Buffer.from(launched), bytes.subarray(0, cut)]),
    );
    expect(await reported()).toEqual([]);
    await appendFile(journal, bytes.subarray(cut));
    expect(await reported()).toEqual(["a1"]);
  });

  test("a malformed line is skipped on its own, never costing the lines around it", async () => {
    await writeFile(
      journal,
      result("a1") +
        "{not json\n" +
        `${JSON.stringify({ type: "result" })}\n` + // a result with no agentId
        result("a2"),
    );
    expect(await reported()).toEqual(["a1", "a2"]);
  });

  test("a journal that shrank was rewritten: its state starts over", async () => {
    await writeFile(journal, launched + result("a1") + result("a2"));
    expect(await reported()).toEqual(["a1", "a2"]);
    await writeFile(journal, result("b1"));
    expect(await reported()).toEqual(["b1"]);
  });

  test("readWorkflowReports keys each run's reports by run id", async () => {
    await writeFile(journal, result("a1"));
    const reports = await readWorkflowReports(SCOPE, [
      { runId: "wf_a", dir: "unused", journalPath: journal },
      { runId: "wf_b", dir: "unused", journalPath: `${journal}.missing` },
    ]);
    expect([...(reports.get("wf_a") ?? [])]).toEqual(["a1"]);
    expect([...(reports.get("wf_b") ?? [])]).toEqual([]);
  });
});
