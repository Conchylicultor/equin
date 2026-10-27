import { describe, expect, it } from "bun:test";
import {
  CRUMBS,
  MAX_SUGGESTIONS,
  commitTarget,
  editText,
  highlightedIn,
  pathBarReducer,
  shownItems,
  splitSuggestion,
  type PathBarAction,
  type PathBarState,
} from "./path-bar-machine";

const run = (actions: PathBarAction[], from: PathBarState = CRUMBS) =>
  actions.reduce(pathBarReducer, from);

describe("path-bar machine", () => {
  it("opens on the path plus one separator", () => {
    expect(editText("/vol/me", "/")).toBe("/vol/me/");
    expect(editText("/", "/")).toBe("/");
    const s = run([{ type: "start", text: "/vol/me/" }]);
    expect(s).toMatchObject({ mode: "editing", text: "/vol/me/" });
  });

  it("shows the first few of a ready answer, none while pending or failed", () => {
    const many = Array.from({ length: 20 }, (_, i) => `/x/d${i}`);
    expect(shownItems({ kind: "ready", items: many })).toHaveLength(
      MAX_SUGGESTIONS,
    );
    expect(shownItems({ kind: "pending" })).toEqual([]);
    expect(shownItems({ kind: "failed", message: "no" })).toEqual([]);
  });

  it("moves the highlight round the list", () => {
    const items = ["/x/a", "/x/b", "/x/c"];
    let s = run([{ type: "start", text: "/x/" }]);
    s = pathBarReducer(s, { type: "move", delta: 1, items });
    expect(s).toMatchObject({ highlighted: 0 });
    s = pathBarReducer(s, { type: "move", delta: -1, items });
    expect(s).toMatchObject({ highlighted: 2 });
    s = pathBarReducer(s, { type: "move", delta: 1, items });
    expect(s).toMatchObject({ highlighted: 0 });
    expect(pathBarReducer(s, { type: "move", delta: 1, items: [] })).toBe(s);
  });

  it("a highlight past a list that shrank under it highlights nothing", () => {
    const s = run([
      { type: "start", text: "/x/" },
      { type: "move", delta: -1, items: ["/x/a", "/x/b", "/x/c"] },
    ]);
    expect(highlightedIn(s, ["/x/a", "/x/b", "/x/c"])).toBe(2);
    expect(highlightedIn(s, ["/x/a"])).toBe(-1);
    expect(commitTarget(s, ["/x/a"], "/")).toBe("/x");
  });

  it("Tab completes the highlighted one, else the first, plus a separator", () => {
    const items = ["/x/a", "/x/b"];
    const base = run([{ type: "start", text: "/x/" }]);
    expect(
      pathBarReducer(base, { type: "complete", separator: "/", items }),
    ).toMatchObject({ text: "/x/a/", highlighted: -1 });
    const moved = run(
      [
        { type: "move", delta: 1, items },
        { type: "move", delta: 1, items },
        { type: "complete", separator: "/", items },
      ],
      base,
    );
    expect(moved).toMatchObject({ text: "/x/b/" });
  });

  it("commits the highlighted one, else the typed text without its trailing separator", () => {
    const typed = run([{ type: "start", text: "/x/y/" }]);
    expect(commitTarget(typed, [], "/")).toBe("/x/y");
    expect(commitTarget(run([{ type: "start", text: "/" }]), [], "/")).toBe(
      "/",
    );
    const items = ["/x/y/z"];
    const picked = run([{ type: "move", delta: 1, items }], typed);
    expect(commitTarget(picked, items, "/")).toBe("/x/y/z");
  });

  it("an invalid commit stays editing, marked bad, until the text changes", () => {
    const bad = run([
      { type: "start", text: "/nope" },
      { type: "validating" },
      { type: "invalid", reason: "No such folder" },
    ]);
    expect(bad).toMatchObject({
      mode: "editing",
      validating: false,
      invalid: { reason: "No such folder" },
    });
    expect(pathBarReducer(bad, { type: "input", text: "/nop" })).toMatchObject({
      invalid: null,
    });
  });

  it("cancel goes back to the crumbs; nothing else acts outside editing", () => {
    const s = run([{ type: "start", text: "/x/" }, { type: "cancel" }]);
    expect(s).toBe(CRUMBS);
    expect(pathBarReducer(CRUMBS, { type: "input", text: "/q" })).toBe(CRUMBS);
  });

  it("splits a suggestion around the typed stem", () => {
    expect(splitSuggestion("/vol/me/Documents", "/vol/me/doc", "/")).toEqual({
      parent: "/vol/me/",
      match: "Doc",
      rest: "uments",
    });
    expect(splitSuggestion("/vol/me/Documents", "/vol/me/", "/")).toEqual({
      parent: "/vol/me/",
      match: "",
      rest: "Documents",
    });
    expect(splitSuggestion("/a/my-docs", "/a/docs", "/")).toEqual({
      parent: "/a/my-",
      match: "docs",
      rest: "",
    });
  });
});
