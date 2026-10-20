import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractResearch, researchTitle } from "./research-docs";

// Arbitrary checkout root: what makes a doc a research doc is the `research/`
// segment and the `.md` suffix, not where the checkout happens to live.
const ROOT = "/checkout/";

function toolCall(name: string, filePath: string): JsonlEvent {
  return {
    kind: "tool-call",
    at: "2026-09-19T10:00:00Z",
    toolUseId: `t-${name}-${filePath}`,
    name,
    input: { file_path: filePath },
  };
}

describe("extractResearch", () => {
  test("writing a design doc created it, editing changed it, reading only saw it", () => {
    const path = `${ROOT}research/2026-09-19-conversations-artifacts-popover.md`;
    expect(extractResearch(toolCall("Write", path))[0]?.relation).toBe(
      "created",
    );
    expect(extractResearch(toolCall("Edit", path))[0]?.relation).toBe("edited");
    expect(extractResearch(toolCall("MultiEdit", path))[0]?.relation).toBe(
      "edited",
    );
    expect(extractResearch(toolCall("Read", path))[0]?.relation).toBe(
      "referenced",
    );
  });

  test("the key is the repo-relative path, not the absolute one the tool got", () => {
    const hits = extractResearch(
      toolCall("Read", `${ROOT}research/2026-09-19-global-thing.md`),
    );
    expect(hits).toEqual([
      {
        kind: "research",
        key: "research/2026-09-19-global-thing.md",
        relation: "referenced",
        at: "2026-09-19T10:00:00Z",
      },
    ]);
  });

  test("a sidequest's own research counts, with its quest in the key", () => {
    const hits = extractResearch(
      toolCall(
        "Write",
        `${ROOT}sidequests/ui-mastery/research/2026-09-19-x.md`,
      ),
    );
    expect(hits[0]?.key).toBe("sidequests/ui-mastery/research/2026-09-19-x.md");
  });

  test("files that are not research docs are not research docs", () => {
    for (const path of [
      `${ROOT}plugins/tasks/web/index.ts`,
      `${ROOT}research/notes.txt`,
      `${ROOT}research/sub/deep.md`,
      `${ROOT}my-research/x.md`,
      `${ROOT}sidequests/ui-mastery/CLAUDE.md`,
    ]) {
      expect(extractResearch(toolCall("Read", path))).toEqual([]);
    }
  });

  test("tools that do not touch files, and events that are not tool calls, find nothing", () => {
    expect(extractResearch(toolCall("Bash", `${ROOT}research/x.md`))).toEqual(
      [],
    );
    expect(
      extractResearch({
        kind: "tool-call",
        at: "2026-09-19T10:00:00Z",
        toolUseId: "t",
        name: "Read",
        input: { pattern: "research/*.md" },
      }),
    ).toEqual([]);
    expect(
      extractResearch({
        kind: "assistant-text",
        at: "2026-09-19T10:00:00Z",
        text: "I read research/2026-09-19-global-thing.md",
      }),
    ).toEqual([]);
  });
});

describe("researchTitle", () => {
  test("the date and the category come off, and the rest reads as a sentence", () => {
    expect(
      researchTitle("research/2026-09-19-conversations-artifacts-popover.md"),
    ).toBe("Artifacts popover");
    expect(researchTitle("research/2026-04-08-web-plugin-api-v2.md")).toBe(
      "Plugin api v2",
    );
  });

  test("a sidequest doc has no category segment, so it keeps every word", () => {
    expect(
      researchTitle(
        "sidequests/ui-mastery/research/2026-09-19-shadow-scale.md",
      ),
    ).toBe("Shadow scale");
  });

  test("a doc whose whole name is one word keeps it rather than going nameless", () => {
    expect(researchTitle("research/2026-09-19-global.md")).toBe("Global");
  });
});
