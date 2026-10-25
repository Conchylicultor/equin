import { describe, expect, test } from "bun:test";
import {
  defineApp,
  defineRoute,
  MissingRouteParamError,
  normalizeRoutePath,
  fillSegment,
  indexKeyedSuffix,
  readIndexKeyedParams,
  readKeyedParams,
  slotKeyedParamNames,
  segmentMatchPatterns,
  splitKeyedPart,
} from "./route";
import { symbol } from "@plugins/ui/plugins/icons/core";

const agents = defineApp({
  id: "agent-manager",
  name: "Agent manager",
  basePath: "/agents",
  icon: symbol("chat-bubble"),
});
const rootApp = defineApp({
  id: "home",
  name: "Home",
  basePath: "/",
  icon: symbol("home"),
});

describe("route link builder", () => {
  test("root route links under the app base path", () => {
    const tasks = defineRoute({ id: "tasks-root", segment: "tasks" });
    expect(tasks.path({})).toBe("/tasks");
    expect(tasks.link(agents, {})).toBe("/agents/tasks");
    expect(tasks.parentPaneIds).toEqual([]);
  });

  test("nested route concatenates the ancestor chain", () => {
    const build = defineRoute({ id: "build", segment: "build" });
    const detail = defineRoute({
      id: "build-detail",
      segment: "r/:runId",
      parent: build,
    });
    expect(detail.path({ runId: "abc" })).toBe("/build/r/abc");
    expect(detail.link(agents, { runId: "abc" })).toBe("/agents/build/r/abc");
    expect(detail.parentPaneIds).toEqual(["build"]);
  });

  test("param values are URL-encoded", () => {
    const conv = defineRoute({ id: "conversation", segment: "c/:convId" });
    expect(conv.link(agents, { convId: "a/b c" })).toBe("/agents/c/a%2Fb%20c");
  });

  test("root app (basePath '/') contributes no prefix", () => {
    const page = defineRoute({ id: "page", segment: "p/:id" });
    expect(page.link(rootApp, { id: "x" })).toBe("/p/x");
  });

  test("missing param fails loud", () => {
    const detail = defineRoute({ id: "d", segment: "r/:runId" });
    // @ts-expect-error — runId is required
    expect(() => detail.path({})).toThrow(/Missing param "runId"/);
  });

  test("a wildcard param spreads its value across segments", () => {
    const file = defineRoute({ id: "file", segment: "f/:path*" });
    // Deliberately not a `plugins/…` path: this is a multi-segment VALUE, not a
    // reference to anything, and `plugin-refs-resolve` reads every `plugins/…`
    // string literal in the repo as a real plugin reference to check.
    expect(file.path({ path: "docs/guide/intro.md" })).toBe(
      "/f/docs/guide/intro.md",
    );
    // Each part is encoded on its own, so the value's own "/" separators stay
    // separators while everything else inside a part is escaped.
    expect(file.link(agents, { path: "a b/c#d" })).toBe(
      "/agents/f/a%20b/c%23d",
    );
  });

  test("an empty segment contributes nothing — the appIndex shape", () => {
    // What an index pane's route looks like: it is reached at its app's bare
    // root and owns no URL fragment of its own.
    const index = defineRoute({ id: "mail-root", segment: "" });
    expect(index.path({})).toBe("/");
    // NOTE the trailing slash: an empty path is "/", and `link` concatenates.
    // Harmless for the root app, and `normalizeRoutePath` preserves it.
    expect(index.link(agents, {})).toBe("/agents/");
    expect(index.link(rootApp, {})).toBe("/");
    expect(index.parentPaneIds).toEqual([]);
  });

  test("a three-level chain concatenates every ancestor segment, root-first", () => {
    const sources = defineRoute({ id: "event-sources", segment: "sources" });
    const source = defineRoute({
      id: "event-source-detail",
      segment: "source/:sourceId",
      parent: sources,
    });
    const run = defineRoute({
      id: "event-source-run",
      segment: "run/:runId",
      parent: source,
    });

    // `parentPaneIds` is TRANSITIVE: the middle route's own ancestor is in the
    // leaf's list. (`defaultAncestors`, the thing routes replace, was a flat
    // one-level list that never recursed.)
    expect(run.parentPaneIds).toEqual(["event-sources", "event-source-detail"]);
    expect(source.parentPaneIds).toEqual(["event-sources"]);
    expect(sources.parentPaneIds).toEqual([]);

    expect(run.path({ sourceId: "s1", runId: "r1" })).toBe(
      "/sources/source/s1/run/r1",
    );
    expect(run.link(agents, { sourceId: "s1", runId: "r1" })).toBe(
      "/agents/sources/source/s1/run/r1",
    );
  });

  test("a missing ANCESTOR param fails as a type, not just a message", () => {
    const source = defineRoute({ id: "src-x", segment: "source/:sourceId" });
    const run = defineRoute({
      id: "run-x",
      segment: "run/:runId",
      parent: source,
    });
    // The chained set is what a URL needs, so the ancestor's param is required
    // — this is a compile error too, which is the point of chaining.
    // A NAMED class, not a bare Error: one caller (a pane's cross-app Expand,
    // which asks for this URL during render) treats "no param, so no URL" as an
    // answer rather than a crash, and narrows on the class to do it.
    // @ts-expect-error — sourceId is required
    expect(() => run.path({ runId: "r" })).toThrow(MissingRouteParamError);
    // @ts-expect-error — sourceId is required
    expect(() => run.path({ runId: "r" })).toThrow(
      /Missing param "sourceId" for segment "source\/:sourceId"/,
    );
  });
});

describe("an optional :param?", () => {
  const detail = defineRoute({
    id: "opt-detail",
    segment: "proto/:name/:stage?",
  });

  test("is written only when supplied, so the bare URL stays valid", () => {
    expect(detail.path({ name: "x" })).toBe("/proto/x");
    expect(detail.path({ name: "x", stage: "compare" })).toBe(
      "/proto/x/compare",
    );
    expect(detail.link(agents, { name: "a b", stage: "c/d" })).toBe(
      "/agents/proto/a%20b/c%2Fd",
    );
  });

  test("is an optional key — the required ones stay required", () => {
    // @ts-expect-error — name is required; only stage is optional
    expect(() => detail.path({ stage: "compare" })).toThrow(
      MissingRouteParamError,
    );
  });

  test("anywhere but the segment's last part has no spelling", () => {
    expect(() =>
      defineRoute({ id: "opt-mid", segment: "proto/:stage?/:name" }),
    ).toThrow(/must be the segment's last part/);
  });

  test("claims both URL shapes for collisions", () => {
    expect(segmentMatchPatterns("proto/:name/:stage?")).toEqual([
      "proto/:",
      "proto/:/:",
    ]);
    expect(segmentMatchPatterns("f/:path*")).toEqual(["f/:*"]);
    expect(segmentMatchPatterns("t/:taskId")).toEqual(["t/:"]);
  });
});

describe("keyed params (`;name`)", () => {
  const song = defineRoute({
    id: "kp-song",
    segment: "song/:songId/:bar?;lens",
  });

  test("are optional keys, written on the pane's last URL part", () => {
    expect(song.path({ songId: "a" })).toBe("/song/a");
    expect(song.path({ songId: "a", lens: "notation" })).toBe(
      "/song/a;lens=notation",
    );
    expect(song.path({ songId: "a", bar: "12", lens: "notation" })).toBe(
      "/song/a/12;lens=notation",
    );
  });

  test("have one spelling: declaration order, values encoded", () => {
    const r = defineRoute({ id: "kp-two", segment: "t/:id;b;a" });
    expect(r.path({ id: "x", a: "1", b: "x;y=z" })).toBe(
      "/t/x;b=x%3By%3Dz;a=1",
    );
  });

  test("read back only the declared names", () => {
    expect(readKeyedParams("lens=notation;stale=1;junk", ["lens"])).toEqual({
      lens: "notation",
    });
    expect(readKeyedParams("b=x%3By%3Dz", ["b"])).toEqual({ b: "x;y=z" });
    expect(splitKeyedPart("12;lens=a")).toEqual({
      base: "12",
      keyed: "lens=a",
    });
    expect(splitKeyedPart("12")).toEqual({ base: "12", keyed: null });
  });

  test("do not change a segment's URL shape", () => {
    expect(segmentMatchPatterns("song/:songId/:bar?;lens")).toEqual([
      "song/:",
      "song/:/:",
    ]);
  });

  test("reject a malformed declaration", () => {
    expect(() =>
      defineRoute({ id: "kp-dup", segment: "t/:lens;lens" }),
    ).toThrow(/declared twice/);
    expect(() => defineRoute({ id: "kp-bad", segment: "t;a-b" })).toThrow(
      /not an identifier/,
    );
    expect(() => defineRoute({ id: "kp-empty", segment: ";lens" })).toThrow(
      /URL part/,
    );
  });
});

describe("the reserved `;view`", () => {
  test("no route may declare it, keyed or positional", () => {
    expect(() =>
      defineRoute({ id: "rv-keyed", segment: "t/:id;view" }),
    ).toThrow(/reserved/);
    expect(() => defineRoute({ id: "rv-pos", segment: "t/:view" })).toThrow(
      /reserved/,
    );
  });

  test("is written on a slot's own segment only, after its declared keys", () => {
    expect(
      fillSegment(
        "song/:id;lens",
        { id: "a", lens: "n", view: "all" },
        {
          ownSlot: true,
        },
      ),
    ).toEqual(["song", "a;lens=n;view=all"]);
    expect(fillSegment("tasks", { view: "open" }, { ownSlot: true })).toEqual([
      "tasks;view=open",
    ]);
    // An ancestor's segment, filled from the chained set, never carries it.
    expect(fillSegment("tasks", { view: "open" })).toEqual(["tasks"]);
    // A segment with no part of its own cannot.
    expect(fillSegment("", { view: "open" }, { ownSlot: true })).toEqual([]);
    expect(slotKeyedParamNames("song/:id;lens")).toEqual(["lens", "view"]);
  });

  test("RouteDef.path never writes it", () => {
    const tasks = defineRoute({ id: "rv-tasks", segment: "tasks" });
    const task = defineRoute({
      id: "rv-task",
      segment: "t/:id",
      parent: tasks,
    });
    expect(task.path({ id: "1", view: "x" } as { id: string })).toBe(
      "/tasks/t/1",
    );
  });

  test("an index pane's suffix round-trips", () => {
    expect(indexKeyedSuffix({})).toBe("");
    expect(indexKeyedSuffix({ view: "recently edited" })).toBe(
      ";view=recently%20edited",
    );
    expect(readIndexKeyedParams("view=recently%20edited;junk=1")).toEqual({
      view: "recently edited",
    });
  });
});

describe("normalizeRoutePath", () => {
  test("collapses a repeated leading slash — the scheme-relative crash", () => {
    // `//agents/c/x` handed to replaceState resolves to `http://agents/c/x`
    // (different origin ⇒ SecurityError), and misses `startsWith("/agents/")`.
    expect(normalizeRoutePath("//agents/c/x")).toBe("/agents/c/x");
    expect(normalizeRoutePath("///agents")).toBe("/agents");
  });

  test("collapses repeated slashes anywhere in the path", () => {
    expect(normalizeRoutePath("/agents//c///x")).toBe("/agents/c/x");
  });

  test("guarantees a leading slash", () => {
    expect(normalizeRoutePath("agents/c/x")).toBe("/agents/c/x");
    expect(normalizeRoutePath("")).toBe("/");
  });

  test("leaves an already-canonical path (and its trailing slash) alone", () => {
    expect(normalizeRoutePath("/")).toBe("/");
    expect(normalizeRoutePath("/agents/c/x")).toBe("/agents/c/x");
    expect(normalizeRoutePath("/agents/")).toBe("/agents/");
  });

  test("is idempotent, so re-normalizing is always safe", () => {
    const once = normalizeRoutePath("//agents//c/x");
    expect(normalizeRoutePath(once)).toBe(once);
  });

  test("does not decode or otherwise touch encoded segments", () => {
    expect(normalizeRoutePath("//agents/c/a%2Fb%20c")).toBe(
      "/agents/c/a%2Fb%20c",
    );
  });
});
