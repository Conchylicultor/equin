import { describe, expect, test } from "bun:test";
import { hydrateSources } from "./hydrate-sources";

const Body = () => null;

describe("hydrateSources", () => {
  test("folds raw, absent and pending", async () => {
    const out = await hydrateSources(
      [
        { sourceId: "a", hydrate: async () => ({ kind: "raw", raw: 1 }) },
        { sourceId: "b", hydrate: async () => ({ kind: "absent" }) },
        {
          sourceId: "c",
          hydrate: async () => ({
            kind: "pending",
            label: "Transcribing",
            Body,
          }),
        },
      ],
      "song-1",
    );
    expect(out.rawMap).toEqual({ a: 1 });
    expect(out.pending).toEqual([
      { sourceId: "c", label: "Transcribing", Body },
    ]);
  });

  test("a raw of undefined is still a raw", async () => {
    const out = await hydrateSources(
      [
        {
          sourceId: "a",
          hydrate: async () => ({ kind: "raw", raw: undefined }),
        },
      ],
      "s",
    );
    expect("a" in out.rawMap).toBe(true);
  });

  test("a rejecting source rejects", async () => {
    const run = hydrateSources(
      [{ sourceId: "a", hydrate: () => Promise.reject(new Error("x")) }],
      "s",
    );
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("x");
  });
});
