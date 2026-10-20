import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractScreenshots, isImagePath, screenshotName } from "./screenshots";

function read(filePath: string): JsonlEvent {
  return toolCall("Read", filePath);
}

function toolCall(name: string, filePath: string): JsonlEvent {
  return {
    kind: "tool-call",
    at: "2026-09-19T10:00:00Z",
    toolUseId: `t-${filePath}`,
    name,
    input: { file_path: filePath },
  };
}

describe("isImagePath", () => {
  test("every extension the image endpoint serves is a picture", () => {
    for (const ext of ["png", "jpg", "JPEG", "gif", "webp", "svg", "avif"]) {
      expect(isImagePath(`/tmp/shot-after.${ext}`)).toBe(true);
    }
  });

  test("anything else is not", () => {
    for (const path of [
      "/tmp/notes.md",
      "/tmp/shot",
      "/tmp/archive.png.gz",
      "/tmp/.png",
      "/tmp/png/file.ts",
    ]) {
      expect(isImagePath(path)).toBe(false);
    }
  });
});

describe("extractScreenshots", () => {
  test("reading a picture is the conversation having made it", () => {
    expect(extractScreenshots(read("/tmp/shot-after.png"))).toEqual([
      {
        kind: "screenshot",
        key: "/tmp/shot-after.png",
        relation: "created",
        at: "2026-09-19T10:00:00Z",
      },
    ]);
  });

  test("the key keeps the path the tool got, temp directory and all", () => {
    const hits = extractScreenshots(read("/var/folders/x/compare/diff.png"));
    expect(hits[0]?.key).toBe("/var/folders/x/compare/diff.png");
  });

  test("a read of something that is not a picture finds nothing", () => {
    expect(
      extractScreenshots(read("/repo/plugins/tasks/web/index.ts")),
    ).toEqual([]);
  });

  test("only Read counts — writing a picture is not something agents do", () => {
    expect(extractScreenshots(toolCall("Write", "/tmp/x.png"))).toEqual([]);
  });

  test("a Read with no file path, and a non-tool event, find nothing", () => {
    expect(
      extractScreenshots({
        kind: "tool-call",
        at: "2026-09-19T10:00:00Z",
        toolUseId: "t",
        name: "Read",
        input: {},
      }),
    ).toEqual([]);
    expect(
      extractScreenshots({
        kind: "user-image",
        at: "2026-09-19T10:00:00Z",
        mime: "image/png",
        data: "…",
      }),
    ).toEqual([]);
  });
});

describe("screenshotName", () => {
  test("the caption is the file name", () => {
    expect(screenshotName("/tmp/compare/shot-after.png")).toBe(
      "shot-after.png",
    );
    expect(screenshotName("shot.png")).toBe("shot.png");
  });
});
