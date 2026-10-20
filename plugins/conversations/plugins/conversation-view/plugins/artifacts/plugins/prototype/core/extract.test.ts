import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractPrototypeHits, PROTOTYPE_KIND } from "./extract";

const A = "proto-1789731211-jeis";
const B = "proto-1786877040-w2vi";
const AT = "2026-09-19T10:00:00Z";
// The folder these fixtures sit in is arbitrary: a prototype is recognised by
// its id appearing in the path, never by where the prototypes live on a machine.
const DIR = "/data/prototypes";

function toolCall(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean },
): JsonlEvent {
  return {
    kind: "tool-call",
    at: AT,
    toolUseId: "t-1",
    name,
    input,
    result: result && { at: AT, ...result },
  };
}

/** `(key, relation)` pairs — what a row would read, with the noise dropped. */
function rows(event: JsonlEvent): [string, string][] {
  return extractPrototypeHits(event).map((h) => {
    expect(h.kind).toBe(PROTOTYPE_KIND);
    expect(h.at).toBe(AT);
    return [h.key, h.relation];
  });
}

describe("extractPrototypeHits — created", () => {
  test("a `prototype new` command creates the id it printed", () => {
    const event = toolCall(
      "Bash",
      { command: './singularity prototype new "Artifacts popover"' },
      { content: `Created ${A}\n  ${DIR}/${A}\n  http://…/${A}` },
    );
    expect(rows(event)).toEqual([[A, "created"]]);
  });

  test("a mint still running claims nothing — there is no id yet", () => {
    const event = toolCall("Bash", {
      command: "./singularity prototype new",
    });
    expect(rows(event)).toEqual([]);
  });

  test("a mint that failed created nothing", () => {
    const event = toolCall(
      "Bash",
      { command: "./singularity prototype new" },
      { content: `boom ${A}`, isError: true },
    );
    expect(rows(event)).toEqual([]);
  });

  test("another Bash command naming an id only references it", () => {
    const event = toolCall(
      "Bash",
      { command: `ls ${DIR}/${A}` },
      { content: `index.html ${B}` },
    );
    // The result is read only for a mint, so B — printed, never asked for —
    // is not an artifact of this conversation.
    expect(rows(event)).toEqual([[A, "referenced"]]);
  });
});

describe("extractPrototypeHits — edited", () => {
  for (const tool of ["Write", "Edit"]) {
    test(`a ${tool} inside the folder edits that prototype`, () => {
      const event = toolCall(tool, {
        file_path: `${DIR}/${A}/index.html`,
        content: "<html></html>",
      });
      expect(rows(event)).toEqual([[A, "edited"]]);
    });
  }

  test("a write elsewhere that mentions an id only references it", () => {
    const event = toolCall("Write", {
      file_path: "/repo/research/plan.md",
      content: `Design explored in ${A}.`,
    });
    expect(rows(event)).toEqual([[A, "referenced"]]);
  });

  test("each id is judged on its own within one call", () => {
    const event = toolCall("Edit", {
      file_path: `${DIR}/${A}/index.html`,
      old_string: "x",
      new_string: `copied from ${B}`,
    });
    expect(rows(event)).toEqual([
      [A, "edited"],
      [B, "referenced"],
    ]);
  });
});

describe("extractPrototypeHits — referenced", () => {
  test("a Read of a prototype file references it", () => {
    const event = toolCall("Read", { file_path: `${DIR}/${A}/index.html` });
    expect(rows(event)).toEqual([[A, "referenced"]]);
  });

  test("an id in a subagent prompt is caught — that is the only trace of it", () => {
    const event = toolCall("Agent", {
      prompt: `Polish the mock at ${A}, do not touch ${B}.`,
    });
    expect(rows(event)).toEqual([
      [A, "referenced"],
      [B, "referenced"],
    ]);
  });

  test("a bare id in the agent's own words counts", () => {
    const event: JsonlEvent = {
      kind: "assistant-text",
      at: AT,
      text: `The mock is ${A}.`,
    };
    expect(rows(event)).toEqual([[A, "referenced"]]);
  });

  test("a bare id in the user's request counts", () => {
    const event: JsonlEvent = { kind: "user-text", at: AT, text: `open ${A}` };
    expect(rows(event)).toEqual([[A, "referenced"]]);
  });
});

describe("extractPrototypeHits — nothing to report", () => {
  test("a call naming no prototype yields no hits", () => {
    expect(rows(toolCall("Read", { file_path: "/repo/README.md" }))).toEqual(
      [],
    );
  });

  test("an event kind that carries neither input nor prose is skipped", () => {
    const event: JsonlEvent = {
      kind: "assistant-thinking",
      at: AT,
      thinking: `maybe ${A}`,
    };
    expect(rows(event)).toEqual([]);
  });

  test("an input that is not an object is still scanned for ids", () => {
    expect(rows(toolCall("Bash", `echo ${A}`))).toEqual([[A, "referenced"]]);
  });
});
