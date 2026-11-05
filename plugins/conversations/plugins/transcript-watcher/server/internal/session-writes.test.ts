import { describe, expect, test } from "bun:test";
import type { FileChangeEvent } from "@plugins/infra/plugins/file-watcher/server";
import {
  notifySessionTranscriptWrites,
  onSessionTranscriptWritten,
  onTranscriptWritten,
  writtenOwnerSessionIds,
  writtenSessions,
} from "./session-writes";

const PROJECTS = "/home/u/.claude/projects";
const A = "ab5453b8-7de7-4fb3-8b87-249a2f3b5613";
const B = "27cbf65a-fb05-413f-b322-5b377a75bb26";

function ev(type: FileChangeEvent["type"], path: string): FileChangeEvent {
  return { type, path };
}

describe("writtenSessions", () => {
  test("names top-level session transcripts created or appended to", () => {
    const written = writtenSessions(
      [
        ev("create", `${PROJECTS}/-wt-a/${A}.jsonl`),
        ev("update", `${PROJECTS}/-wt-b/${B}.jsonl`),
        ev("update", `${PROJECTS}/-wt-a/${A}.jsonl`),
      ],
      PROJECTS,
    );
    expect(Object.fromEntries(written)).toEqual({
      [A]: `${PROJECTS}/-wt-a/${A}.jsonl`,
      [B]: `${PROJECTS}/-wt-b/${B}.jsonl`,
    });
  });

  test("ignores deletions, sub-agent files and non-session names", () => {
    const written = writtenSessions(
      [
        ev("delete", `${PROJECTS}/-wt-a/${A}.jsonl`),
        ev("create", `${PROJECTS}/-wt-a/${A}/subagents/agent-1.jsonl`),
        ev("create", `${PROJECTS}/-wt-a/notes.jsonl`),
        ev("create", `/elsewhere/-wt-a/${B}.jsonl`),
      ],
      PROJECTS,
    );
    expect(written.size).toBe(0);
  });
});

describe("onSessionTranscriptWritten", () => {
  test("a batch reaches every listener once, until it unsubscribes", () => {
    const heard: [string, string][][] = [];
    const off = onSessionTranscriptWritten((written) =>
      heard.push([...written]),
    );
    notifySessionTranscriptWrites(
      [
        ev("create", `${PROJECTS}/-wt-a/${A}.jsonl`),
        ev("update", `${PROJECTS}/-wt-a/${A}.jsonl`),
      ],
      PROJECTS,
    );
    // A batch touching no session is not delivered at all.
    notifySessionTranscriptWrites([], PROJECTS);
    off();
    notifySessionTranscriptWrites(
      [ev("create", `${PROJECTS}/-wt-b/${B}.jsonl`)],
      PROJECTS,
    );
    expect(heard).toEqual([[[A, `${PROJECTS}/-wt-a/${A}.jsonl`]]]);
  });
});

describe("writtenOwnerSessionIds", () => {
  test("names the owning session of session and sub-agent transcripts", () => {
    const ids = writtenOwnerSessionIds(
      [
        ev("update", `${PROJECTS}/-wt-a/${A}.jsonl`),
        ev("create", `${PROJECTS}/-wt-b/${B}/subagents/agent-1.jsonl`),
        ev(
          "update",
          `${PROJECTS}/-wt-b/${B}/subagents/workflows/wf_x/agent-2.jsonl`,
        ),
      ],
      PROJECTS,
    );
    expect([...ids].sort()).toEqual([A, B].sort());
  });

  test("ignores deletions, foreign roots and non-agent files", () => {
    const ids = writtenOwnerSessionIds(
      [
        ev("delete", `${PROJECTS}/-wt-a/${A}/subagents/agent-1.jsonl`),
        ev("create", `${PROJECTS}/-wt-a/${A}/subagents/notes.jsonl`),
        ev("create", `${PROJECTS}/-wt-a/notes/subagents/agent-1.jsonl`),
        ev("create", `/elsewhere/-wt-a/${B}/subagents/agent-1.jsonl`),
      ],
      PROJECTS,
    );
    expect(ids.size).toBe(0);
  });

  test("onTranscriptWritten hears sub-agent writes", () => {
    const heard: string[][] = [];
    const off = onTranscriptWritten((ids) => heard.push([...ids]));
    notifySessionTranscriptWrites(
      [ev("update", `${PROJECTS}/-wt-a/${A}/subagents/agent-1.jsonl`)],
      PROJECTS,
    );
    off();
    expect(heard).toEqual([[A]]);
  });
});
