import { describe, expect, test } from "bun:test";
import { ARCHIVED_IMAGE_TEXT, archiveTranscriptJsonl } from "./archive-form";
import { TranscriptLines, wholeBytes } from "./transcript-lines";

// A 1400×900 PNG's signature and IHDR — all the size reader needs.
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 0x05, 0x78, 0, 0, 0x03, 0x84, 8, 6, 0, 0, 0,
]);
const base64 = btoa(String.fromCharCode(...png));
const imagePart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: base64 },
};

const T = "2026-11-04T01:00:00.000Z";

const userPrompt = {
  type: "user",
  uuid: "u1",
  timestamp: T,
  message: {
    role: "user",
    content: [{ type: "text", text: "look at this" }, imagePart],
  },
};
const toolCall = {
  type: "assistant",
  uuid: "u2",
  parentUuid: "u1",
  timestamp: T,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "t1",
        name: "mcp__equin__browser_screenshot",
        input: {},
      },
      { type: "tool_use", id: "t2", name: "Read", input: { path: "a.png" } },
    ],
  },
};
const mcpResult = {
  type: "user",
  uuid: "u3",
  parentUuid: "u2",
  timestamp: T,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "captured" }, imagePart],
      },
    ],
  },
  toolUseResult: [{ type: "text", text: "captured" }, imagePart],
};
const readResult = {
  type: "user",
  uuid: "u4",
  parentUuid: "u3",
  timestamp: T,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t2", content: [imagePart] }],
  },
  toolUseResult: {
    type: "image",
    file: { base64, type: "image/png", originalSize: 29 },
  },
};
const lines = [userPrompt, toolCall, mcpResult, readResult];
const jsonl = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

async function eventsOf(text: string) {
  const held = new TranscriptLines(() => Promise.resolve(null));
  const bytes = new TextEncoder().encode(text);
  await held.catchUp("a.jsonl", bytes.length, wholeBytes(bytes));
  return held.events();
}

describe("archiveTranscriptJsonl", () => {
  const archived = archiveTranscriptJsonl(jsonl);
  const out = archived.jsonl.split("\n");

  test("leaves out every tool image, counting the results' own", () => {
    expect(archived.imagesLeftOut).toBe(2);
    // Only the user's own image is left.
    expect(archived.jsonl.split(base64).length - 1).toBe(1);
  });

  test("a stripped result says so, so a resumed agent gets no empty result", () => {
    // The archived lines' shape, not the fixtures': a result now holds text.
    const read = JSON.parse(out[3]!) as {
      message: { content: { content: unknown }[] };
    };
    expect(read.message.content[0]!.content).toEqual([
      { type: "text", text: ARCHIVED_IMAGE_TEXT },
    ]);
    const mcp = JSON.parse(out[2]!) as { toolUseResult: unknown };
    expect(mcp.toolUseResult).toEqual([
      { type: "text", text: "captured" },
      { type: "text", text: ARCHIVED_IMAGE_TEXT },
    ]);
  });

  test("keeps the rest of toolUseResult", () => {
    const read = JSON.parse(out[3]!) as {
      toolUseResult: { type: string; file: Record<string, unknown> };
    };
    expect(read.toolUseResult).toEqual({
      type: "image",
      file: { type: "image/png", originalSize: 29 },
    });
  });

  test("lines without a tool image stay byte-for-byte", () => {
    expect(out[0]).toBe(JSON.stringify(userPrompt));
    expect(out[1]).toBe(JSON.stringify(toolCall));
    expect(archived.jsonl.endsWith("\n")).toBe(true);
  });

  test("a torn line is archived as it is", () => {
    const torn = jsonl + '{"type":"user","message":{"content":[{"type":"image"';
    expect(
      archiveTranscriptJsonl(torn).jsonl.endsWith(torn.slice(jsonl.length)),
    ).toBe(true);
  });

  test("a restored transcript renders as the original, but for the note", async () => {
    // Image keys name the line's byte offset, which moves; the note is the one
    // thing the archive says that the original did not.
    const comparable = (events: unknown) =>
      JSON.parse(
        JSON.stringify(events)
          .replace(/"(key|data)":"[A-Za-z0-9_-]{20,}"/g, '"$1":"<key>"')
          .replaceAll(`\\n${ARCHIVED_IMAGE_TEXT}`, "")
          .replaceAll(ARCHIVED_IMAGE_TEXT, ""),
      ) as unknown;
    const restored = await eventsOf(archived.jsonl);
    expect(JSON.stringify(restored)).toContain(ARCHIVED_IMAGE_TEXT);
    expect(comparable(restored)).toEqual(comparable(await eventsOf(jsonl)));
  });
});
