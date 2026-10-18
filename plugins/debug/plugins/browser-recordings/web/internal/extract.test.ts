import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { extractBrowserRecordings } from "./extract";

const call = (name: string, input: unknown) =>
  ({
    kind: "tool-call",
    at: "2026-10-18T00:00:00Z",
    toolUseId: "toolu_1",
    name,
    input,
  }) as JsonlEvent;

describe("extractBrowserRecordings", () => {
  test("a recorded call is keyed by its tool-use id", () => {
    const hit = {
      kind: "browser-recording",
      key: "toolu_1",
      relation: "created",
      at: "2026-10-18T00:00:00Z",
    } as const;
    expect(
      extractBrowserRecordings(
        call("Bash", { command: "./singularity run plugins/x/e2e/flow.ts" }),
      ),
    ).toEqual([hit]);
    expect(
      extractBrowserRecordings(call("mcp__equin__browser_act", {})),
    ).toEqual([hit]);
  });

  test("other calls are not recordings", () => {
    expect(
      extractBrowserRecordings(
        call("Bash", { command: "./singularity build" }),
      ),
    ).toEqual([]);
    expect(
      extractBrowserRecordings(call("mcp__equin__browser_read_page", {})),
    ).toEqual([]);
  });
});
