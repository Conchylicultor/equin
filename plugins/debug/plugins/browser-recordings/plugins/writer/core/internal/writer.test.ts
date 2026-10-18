import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_FILE,
  RecordingManifestSchema,
} from "@plugins/debug/plugins/browser-recordings/core";
import { openRecording } from "./writer";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("openRecording", () => {
  test("stores a picture once and writes the manifest on close", async () => {
    root = await mkdtemp(join(tmpdir(), "rec-"));
    const rec = openRecording({
      root,
      toolUseId: "toolu_1",
      source: { kind: "mcp", tool: "browser_act" },
      name: "browser_act",
    });
    const a = await rec.frame(new Uint8Array([1, 2, 3]), "png");
    const b = await rec.frame(new Uint8Array([1, 2, 3]), "png");
    const c = await rec.frame(new Uint8Array([4]), "jpeg");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(c.endsWith(".jpg")).toBe(true);
    expect(rec.dir.startsWith(join(root, "toolu_1"))).toBe(true);
    // No manifest until close: the recording is not listed yet.
    expect(await readdir(rec.dir)).toEqual(["frames"]);

    await rec.close([
      { title: "act click", startMs: 0, durationMs: 5, frame: a },
    ]);
    const manifest = RecordingManifestSchema.parse(
      JSON.parse(await readFile(join(rec.dir, MANIFEST_FILE), "utf8")),
    );
    expect(manifest.toolUseId).toBe("toolu_1");
    expect(manifest.steps[0]?.frame).toBe(a);
    expect((await readdir(join(rec.dir, "frames"))).length).toBe(2);
  });

  test("an id that is not a path segment is refused", () => {
    expect(() =>
      openRecording({
        root: "/nowhere",
        toolUseId: "../x",
        source: { kind: "e2e", script: "x.ts" },
        name: "x",
      }),
    ).toThrow("not a tool-use id");
  });
});
