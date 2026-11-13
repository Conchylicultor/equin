import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_FILE,
  RECORDED_CALLS_FILE,
  RecordingManifestSchema,
} from "@plugins/debug/plugins/browser-recordings/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { openRecording } from "./writer";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("openRecording", () => {
  test("stores a picture once and writes the manifest on close", async () => {
    root = await mkdtemp(join(tmpdir(), "rec-"));
    const rec = openRecording({
      root: asAppPath(root),
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

  test("a prune removes call directories empty for a minute, never a fresh one", async () => {
    root = await mkdtemp(join(tmpdir(), "rec-"));
    // Emptied long ago (debris) and just now (maybe a recording mid-create).
    await mkdir(join(root, "toolu_emptied"), { recursive: true });
    const long = new Date(Date.now() - 120_000);
    await utimes(join(root, "toolu_emptied"), long, long);
    await mkdir(join(root, "toolu_fresh"), { recursive: true });
    const rec = openRecording({
      root: asAppPath(root),
      toolUseId: "toolu_1",
      source: { kind: "mcp", tool: "browser_act" },
      name: "browser_act",
    });
    await rec.close([]);
    expect(
      (await readdir(root)).filter((n) => n.startsWith("toolu_")).sort(),
    ).toEqual(["toolu_1", "toolu_fresh"]);
  });

  test("an id that is not a path segment is refused", () => {
    expect(() =>
      openRecording({
        root: asAppPath("/nowhere"),
        toolUseId: "../x",
        source: { kind: "e2e", script: "x.ts" },
        name: "x",
      }),
    ).toThrow("not a tool-use id");
  });

  test("recordings closing at once prune the shared root without tripping on each other", async () => {
    root = await mkdtemp(join(tmpdir(), "rec-"));
    // Past the keep bound, one run per call, all older than the new ones: every
    // prune empties call directories, and the ones that overlap race on them.
    const old = new Date(Date.now() - 60_000);
    for (let i = 0; i < 230; i++) {
      const run = join(root, `toolu_old${i}`, "run");
      await mkdir(run, { recursive: true });
      await utimes(run, old, old);
    }
    const recs = Array.from({ length: 12 }, (_, i) =>
      openRecording({
        root: asAppPath(root),
        toolUseId: `toolu_new${i}`,
        source: { kind: "mcp", tool: "browser_act" },
        name: "browser_act",
      }),
    );
    await Promise.all(recs.map((rec) => rec.close([])));
    // Every new run survived and is listed: a close that found the lock held
    // waited for its own prune instead of trusting the holder's listing.
    const listed: unknown = JSON.parse(
      await readFile(join(root, RECORDED_CALLS_FILE), "utf8"),
    );
    for (let i = 0; i < recs.length; i++)
      expect(listed).toContain(`toolu_new${i}`);
    // A later close brings the root to its bound.
    for (const rec of recs)
      expect(await readdir(rec.dir)).toEqual([MANIFEST_FILE]);
    await openRecording({
      root: asAppPath(root),
      toolUseId: "toolu_last",
      source: { kind: "mcp", tool: "browser_act" },
      name: "browser_act",
    }).close([]);
    // The calls the prune emptied stay until they have been empty a minute
    // (a later prune removes them); the runs are at the bound.
    const calls = (await readdir(root, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    );
    let runs = 0;
    for (const call of calls)
      runs += (await readdir(join(root, call.name))).length;
    expect(runs).toBe(200);
  });
});
