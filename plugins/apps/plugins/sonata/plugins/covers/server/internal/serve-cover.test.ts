import { describe, expect, it } from "bun:test";
import type { CoverLookup, CoverStore } from "./cover-cache";
import {
  coverCacheKey,
  createCoverServer,
  type ScoreCoverRequest,
} from "./serve-cover";

function memoryStore(): CoverStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (key): Promise<CoverLookup> => {
      const svg = files.get(key);
      return svg === undefined ? { hit: false } : { hit: true, svg };
    },
    write: async (key, svg) => {
      files.set(key, svg);
    },
  };
}

const req = (over: Partial<ScoreCoverRequest> = {}): ScoreCoverRequest => ({
  version: "v2",
  current: "v2",
  contentHash: "abc",
  render: async () => "<svg/>",
  ...over,
});

describe("createCoverServer", () => {
  it("serves an immutable SVG when the URL's version is current", async () => {
    const res = await createCoverServer(memoryStore())(req());
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("<svg/>");
  });

  it("serves the current render no-store for a stale version", async () => {
    const res = await createCoverServer(memoryStore())(req({ version: "v1" }));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("<svg/>");
  });

  it("stores the render under its key and serves later requests from it", async () => {
    const store = memoryStore();
    const serve = createCoverServer(store);
    let renders = 0;
    const render = async () => `<svg data-n="${++renders}"/>`;
    await serve(req({ render }));
    const second = await serve(req({ render }));
    expect(renders).toBe(1);
    expect(await second.text()).toBe('<svg data-n="1"/>');
    expect([...store.files.keys()]).toEqual([coverCacheKey("abc")]);
  });

  it("a different content hash is a different cover", async () => {
    const store = memoryStore();
    const serve = createCoverServer(store);
    await serve(req({ contentHash: "a" }));
    await serve(req({ contentHash: "b" }));
    expect(store.files.size).toBe(2);
  });

  it("concurrent misses share one render", async () => {
    const serve = createCoverServer(memoryStore());
    let renders = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const render = async () => {
      renders++;
      await gate;
      return "<svg/>";
    };
    const all = Promise.all([1, 2, 3].map(() => serve(req({ render }))));
    // A macrotask: every request has read the (empty) store and joined the
    // flight before the render is let go.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const responses = await all;
    expect(renders).toBe(1);
    expect(responses.every((r) => r.status === 200)).toBe(true);
  });

  it("a failed render rejects and stores nothing", async () => {
    const store = memoryStore();
    const serve = createCoverServer(store);
    let thrown: unknown = null;
    try {
      await serve(
        req({
          render: async () => {
            throw new Error("bad score");
          },
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("bad score");
    expect(store.files.size).toBe(0);
  });
});
