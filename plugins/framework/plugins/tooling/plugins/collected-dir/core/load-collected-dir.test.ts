import { describe, expect, it } from "bun:test";
import { loadCollectedDir, type CollectedEntry } from "./load-collected-dir";

const isString = (v: unknown): v is string => typeof v === "string";

function entry(
  pluginPath: string,
  loader: CollectedEntry["loader"],
): CollectedEntry {
  return { pluginPath, id: pluginPath, loader, dependsOn: [] };
}

describe("loadCollectedDir isPresent", () => {
  it("skips a stale entry under strict without loading it", async () => {
    let loadedStale = false;
    const items = await loadCollectedDir(
      [
        entry("kept", () => Promise.resolve({ default: "a" })),
        entry("deleted", () => {
          loadedStale = true;
          return Promise.reject(new Error("Cannot find module"));
        }),
      ],
      {
        isItem: isString,
        strict: true,
        isPresent: (e) => e.pluginPath !== "deleted",
      },
    );
    expect(items).toEqual(["a"]);
    expect(loadedStale).toBe(false);
  });

  it("still fails strict on a present entry whose loader throws", async () => {
    const rejected = loadCollectedDir(
        [entry("broken", () => Promise.reject(new Error("boom")))],
      { isItem: isString, strict: true, isPresent: () => true },
    );
    expect(rejected).rejects.toThrow("broken — loader threw: boom");
  });

  it("still fails strict on a present entry with no default export", async () => {
    const rejected = loadCollectedDir(
        [entry("empty", () => Promise.resolve({ default: undefined }))],
      { isItem: isString, strict: true, isPresent: () => true },
    );
    expect(rejected).rejects.toThrow("empty — no default export");
  });
});
