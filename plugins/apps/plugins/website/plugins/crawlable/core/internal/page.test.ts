import { describe, expect, test } from "bun:test";
import {
  WebsitePageError,
  defineWebsitePage,
  websitePaneIdentity,
} from "./page";

const page = (path: string) =>
  defineWebsitePage({ path, title: "T", description: "D." });

describe("defineWebsitePage", () => {
  test("accepts the base path and static paths under it", () => {
    expect(page("/about").path).toBe("/about");
    expect(page("/about/download").path).toBe("/about/download");
    expect(page("/about/docs/getting-started").path).toBe(
      "/about/docs/getting-started",
    );
  });

  test("returns a frozen copy", () => {
    const p = page("/about/apps");
    expect(Object.isFrozen(p)).toBe(true);
  });

  test.each([
    ["relative", "about/apps"],
    ["outside the base path", "/apps"],
    ["a sibling sharing the prefix", "/websites/apps"],
    ["a trailing slash", "/about/apps/"],
    ["the base path with a trailing slash", "/about/"],
    ["a param", "/about/:id"],
    ["a wildcard", "/about/*"],
    ["a keyed param", "/about/apps;view=x"],
    ["a query", "/about/apps?x=1"],
    ["a fragment", "/about/apps#top"],
    ["an empty segment", "/about//apps"],
    ["a dot segment", "/about/../agents"],
    ["upper case", "/about/Apps"],
  ])("refuses %s (%s)", (_, path) => {
    expect(() => page(path)).toThrow(WebsitePageError);
  });

  test("refuses an empty title or description", () => {
    expect(() =>
      defineWebsitePage({ path: "/about", title: " ", description: "D." }),
    ).toThrow(/empty title/);
    expect(() =>
      defineWebsitePage({ path: "/about", title: "T", description: "" }),
    ).toThrow(/empty description/);
  });
});

describe("websitePaneIdentity", () => {
  test("derives the route from the path, the landing page as the index", () => {
    expect(websitePaneIdentity("/about")).toEqual({
      id: "website-landing",
      segment: "",
      appIndex: true,
    });
    expect(websitePaneIdentity("/about/download")).toEqual({
      id: "website-download",
      segment: "download",
      appIndex: false,
    });
    expect(websitePaneIdentity("/about/a/b")).toEqual({
      id: "website-a-b",
      segment: "a/b",
      appIndex: false,
    });
  });
});
