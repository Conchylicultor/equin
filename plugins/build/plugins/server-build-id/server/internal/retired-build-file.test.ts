import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetiredBuildFileIn } from "./retired-build-file";

let root: string;
let dist: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "retired-build-file-"));
  dist = join(root, "web.live.1");
  const store = join(root, "store");
  mkdirSync(join(store, "kept.web.aaa"), { recursive: true });
  const addresses = join(root, "web-addresses");
  mkdirSync(addresses);
  symlinkSync(join(store, "kept.web.aaa"), join(addresses, "kept.web.aaa"));
  // A link whose store entry is gone: the gateway 404s it.
  symlinkSync(
    join(store, "pruned.web.bbb"),
    join(addresses, "dangling.web.bbb"),
  );
  mkdirSync(dist);
  symlinkSync(addresses, join(dist, "artifacts"));
  mkdirSync(`${dist}-graphs`);
  writeFileSync(`${dist}-graphs/retained.names`, "kept.web.aaa\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const gone = "/artifacts/gone.web.ccc/index.js";

describe("isRetiredBuildFileIn", () => {
  test("a missing file of a retired graph is proven", async () => {
    expect(
      await isRetiredBuildFileIn(dist, "served", { graph: "old", path: gone }),
    ).toBe(true);
    expect(
      await isRetiredBuildFileIn(dist, "served", {
        graph: "old",
        path: "/artifacts/dangling.web.bbb/index.js",
      }),
    ).toBe(true);
  });

  test("a file still served proves nothing (the load failed for another reason)", async () => {
    expect(
      await isRetiredBuildFileIn(dist, "served", {
        graph: "old",
        path: "/artifacts/kept.web.aaa/index.js",
      }),
    ).toBe(false);
  });

  test("a graph still retained, or the served one, is never retired", async () => {
    for (const graph of ["retained", "served"]) {
      expect(
        await isRetiredBuildFileIn(dist, "served", { graph, path: gone }),
      ).toBe(false);
    }
  });

  test("no graph, a malformed one, or a path outside /artifacts proves nothing", async () => {
    for (const occurrence of [
      { graph: null, path: gone },
      { graph: "../x", path: gone },
      { graph: "old", path: "/index.html" },
      { graph: "old", path: "/artifacts/../x" },
    ]) {
      expect(await isRetiredBuildFileIn(dist, "served", occurrence)).toBe(
        false,
      );
    }
  });

  test("a dist that keeps no graph records (a release) retires nothing", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    symlinkSync(join(root, "web-addresses"), join(bare, "artifacts"));
    expect(
      await isRetiredBuildFileIn(bare, "served", { graph: "old", path: gone }),
    ).toBe(false);
  });
});
