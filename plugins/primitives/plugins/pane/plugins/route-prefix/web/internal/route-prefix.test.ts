import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resetRoutePrefixForTests,
  setActiveRoutePrefix,
  setRoutePrefixes,
  splitRoutePrefix,
  withActiveRoutePrefix,
} from "./route-prefix";

beforeEach(() => setRoutePrefixes(["/desktop"]));
afterEach(() => resetRoutePrefixForTests());

describe("splitRoutePrefix", () => {
  it("strips a known prefix at a segment boundary", () => {
    expect(splitRoutePrefix("/desktop/agents/c/1")).toEqual({
      prefix: "/desktop",
      path: "/agents/c/1",
    });
  });

  it("a bare prefix is the root route", () => {
    expect(splitRoutePrefix("/desktop")).toEqual({
      prefix: "/desktop",
      path: "/",
    });
  });

  it("leaves other paths alone, including a mere string prefix", () => {
    expect(splitRoutePrefix("/agents/c/1")).toEqual({
      prefix: undefined,
      path: "/agents/c/1",
    });
    expect(splitRoutePrefix("/desktopx")).toEqual({
      prefix: undefined,
      path: "/desktopx",
    });
  });

  it("rejects a prefix that is not a path", () => {
    expect(() => setRoutePrefixes(["/"])).toThrow();
    expect(() => setRoutePrefixes(["desktop"])).toThrow();
  });
});

describe("withActiveRoutePrefix", () => {
  it("is the identity with no active prefix", () => {
    expect(withActiveRoutePrefix("/agents/c/1")).toBe("/agents/c/1");
  });

  it("writes the active prefix in front of an in-app URL", () => {
    setActiveRoutePrefix("/desktop");
    expect(withActiveRoutePrefix("/agents/c/1?x=1#h")).toBe(
      "/desktop/agents/c/1?x=1#h",
    );
    expect(withActiveRoutePrefix("/")).toBe("/desktop");
    expect(withActiveRoutePrefix("/?embed=1")).toBe("/desktop?embed=1");
  });

  it("leaves absolute URLs and already-prefixed paths alone", () => {
    setActiveRoutePrefix("/desktop");
    expect(withActiveRoutePrefix("https://x.dev/a")).toBe("https://x.dev/a");
    expect(withActiveRoutePrefix("//x.dev/a")).toBe("//x.dev/a");
    expect(withActiveRoutePrefix("/desktop/agents")).toBe("/desktop/agents");
  });
});
