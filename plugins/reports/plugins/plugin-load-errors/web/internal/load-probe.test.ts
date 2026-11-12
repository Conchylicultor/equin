import { describe, expect, test } from "bun:test";
import {
  createLoadProbe,
  type FileAnswer,
  type LoadProbeIo,
} from "./load-probe";

const ORIGIN = "http://equin.localhost:9000";

// A served fleet: path → status (or unreachable), and per-artifact metadata.
function io(opts: {
  map: Record<string, string>;
  files: Record<string, number | "down">;
  meta: Record<string, Record<string, string[]>>;
}): LoadProbeIo & { asked: string[] } {
  const asked: string[] = [];
  const answer = (path: string): FileAnswer => {
    const s = opts.files[path] ?? 404;
    return s === "down"
      ? { kind: "unreachable", error: "Load failed" }
      : { kind: "status", status: s };
  };
  return {
    asked,
    origin: ORIGIN,
    importMap: () => new Map(Object.entries(opts.map)),
    head: (path) => {
      asked.push(path);
      return Promise.resolve(answer(path));
    },
    meta: (path) => {
      const name = /^\/artifacts\/([^/]+)\//.exec(path)?.[1] ?? "";
      const m = opts.meta[name];
      return Promise.resolve(
        m === undefined
          ? { answer: { kind: "status", status: 404 }, body: undefined }
          : {
              answer: { kind: "status", status: 200 },
              body: { staticImportsByFile: m },
            },
      );
    },
  };
}

const map = {
  "@plugins/a/web": "/artifacts/a.web.1/index.js",
  "@plugins/b/core": "/artifacts/b.core.1/index.js",
  react: "/artifacts/set.v/react.js",
};
const meta = {
  "a.web.1": {
    "index.js": ["@plugins/b/core", "react", "./chunk.mjs"],
    "chunk.mjs": [],
  },
  "b.core.1": { "index.js": ["react"] },
};

describe("createLoadProbe", () => {
  test("a 404 anywhere in the failing module's static graph is the missing file", async () => {
    const { probe } = createLoadProbe(
      io({
        map,
        meta,
        files: {
          "/artifacts/a.web.1/index.js": 200,
          "/artifacts/a.web.1/chunk.mjs": 200,
          "/artifacts/set.v/react.js": 200,
        },
      }),
    );
    expect(await probe("@plugins/a/web")).toEqual({
      kind: "missing",
      path: "/artifacts/b.core.1/index.js",
    });
  });

  test("every file served: nothing explains the failure", async () => {
    const fleet = io({
      map,
      meta,
      files: {
        "/artifacts/a.web.1/index.js": 200,
        "/artifacts/a.web.1/chunk.mjs": 200,
        "/artifacts/b.core.1/index.js": 200,
        "/artifacts/set.v/react.js": 200,
      },
    });
    expect(await createLoadProbe(fleet).probe("@plugins/a/web")).toEqual({
      kind: "served",
      files: 4,
    });
    // Each file asked once, though react is reached twice.
    expect(fleet.asked.filter((p) => p.endsWith("react.js"))).toHaveLength(1);
  });

  test("a network error or another status proves nothing", async () => {
    expect(
      await createLoadProbe(
        io({ map, meta, files: { "/artifacts/a.web.1/index.js": "down" } }),
      ).probe("@plugins/a/web"),
    ).toEqual({
      kind: "unreachable",
      path: "/artifacts/a.web.1/index.js",
      error: "Load failed",
    });
    expect(
      await createLoadProbe(
        io({ map, meta, files: { "/artifacts/a.web.1/index.js": 502 } }),
      ).probe("@plugins/a/web"),
    ).toEqual({
      kind: "status",
      path: "/artifacts/a.web.1/index.js",
      status: 502,
    });
  });

  test("a module outside the import map is not probed", async () => {
    expect(
      (
        await createLoadProbe(io({ map, meta, files: {} })).probe(
          "@plugins/z/web",
        )
      ).kind,
    ).toBe("unprobed");
  });
});
