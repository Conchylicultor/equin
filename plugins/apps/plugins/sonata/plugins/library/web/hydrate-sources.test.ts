import { describe, expect, test } from "bun:test";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { hydrateSources } from "./hydrate-sources";
import type { SourceContext } from "./slots";

const Body = () => null;
const ctx: SourceContext = { fetchEndpoint: fakeFetchEndpoint().fetchEndpoint };

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
      ctx,
    );
    expect(out.rawMap).toEqual({ a: 1 });
    expect(out.pending).toEqual([
      { sourceId: "c", label: "Transcribing", Body },
    ]);
  });

  test("hands every source the song and the context", async () => {
    const seen: [string, SourceContext][] = [];
    await hydrateSources(
      [
        {
          sourceId: "a",
          hydrate: async (songId, c) => {
            seen.push([songId, c]);
            return { kind: "absent" };
          },
        },
      ],
      "song-1",
      ctx,
    );
    expect(seen).toEqual([["song-1", ctx]]);
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
      ctx,
    );
    expect("a" in out.rawMap).toBe(true);
  });

  test("a rejecting source rejects", async () => {
    const run = hydrateSources(
      [{ sourceId: "a", hydrate: () => Promise.reject(new Error("x")) }],
      "s",
      ctx,
    );
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("x");
  });
});
