import { describe, expect, test } from "bun:test";
import {
  createLoadProbe,
  failedModuleUrlOf,
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

// The linked page: no `@plugins/*` specifier is mapped — a plugin loads by its
// chunk's URL, which imports boot chunks by `@chunk/<id>`, lazy ones by
// relative URL, and vendors by name.
const map = {
  "@chunk/b": "/artifacts/b.core.1/index.js",
  react: "/artifacts/set.v/react.js",
};
const meta = {
  "a.web.1": {
    "index.js": ["@chunk/b", "react", "./chunk.mjs"],
    "chunk.mjs": [],
  },
  "b.core.1": { "index.js": ["react"] },
};
// The module the browser said it failed to fetch.
const A = `${ORIGIN}/artifacts/a.web.1/index.js`;

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
    expect(await probe(A)).toEqual({
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
    expect(await createLoadProbe(fleet).probe(A)).toEqual({
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
      ).probe(A),
    ).toEqual({
      kind: "unreachable",
      path: "/artifacts/a.web.1/index.js",
      error: "Load failed",
    });
    expect(
      await createLoadProbe(
        io({ map, meta, files: { "/artifacts/a.web.1/index.js": 502 } }),
      ).probe(A),
    ).toEqual({
      kind: "status",
      path: "/artifacts/a.web.1/index.js",
      status: 502,
    });
  });

  test("a module that is not an artifact file of this origin is not probed", async () => {
    const probe = createLoadProbe(io({ map, meta, files: {} }));
    expect((await probe.probe("https://elsewhere.test/artifacts/a/index.js")).kind).toBe(
      "unprobed",
    );
    expect((await probe.probe(`${ORIGIN}/src/main.tsx`)).kind).toBe("unprobed");
  });
});

describe("failedModuleUrlOf", () => {
  test("Chromium names the module it failed to fetch", () => {
    expect(
      failedModuleUrlOf(
        "Failed to fetch dynamically imported module: https://equin.ai/artifacts/chunk.5a206f14d1ab4fee/index.js",
      ),
    ).toBe("https://equin.ai/artifacts/chunk.5a206f14d1ab4fee/index.js");
  });

  test("WebKit names none", () => {
    expect(failedModuleUrlOf("Importing a module script failed.")).toBeNull();
  });
});
