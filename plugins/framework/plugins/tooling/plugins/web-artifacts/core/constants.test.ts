import { describe, expect, test } from "bun:test";
import { isWorkerChunkPath } from "./constants";

describe("isWorkerChunkPath", () => {
  test("an artifact's worker chunk", () => {
    expect(
      isWorkerChunkPath(
        "/artifacts/primitives.networking.web.9a30bf2b5ff8827f/assets/shared-ws.worker-BY1sWT1i.js",
      ),
    ).toBe(true);
  });

  test("a module of a worker tree (a browser host's worker)", () => {
    expect(
      isWorkerChunkPath(
        "/artifacts/worker-tree.acf276983f235246/apps.website.demos.workspace.bin/index.js",
      ),
    ).toBe(true);
  });

  test("anything else is not", () => {
    for (const path of [
      "/artifacts/primitives.networking.web.9a30bf2b5ff8827f/index.js",
      "/artifacts/x.web.1/assets/w.js.map",
      "/assets/style-D0aYsD9r.css",
      "/assets/app.js",
      "/artifacts/x.web.1/nested/assets/w.js",
      "/artifacts/worker-tree.acf276983f235246/x.bin/index.js.map",
      "/artifacts/worker-tree.acf276983f235246",
    ]) {
      expect(isWorkerChunkPath(path)).toBe(false);
    }
  });
});
