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
    expect(page("/website").path).toBe("/website");
    expect(page("/website/download").path).toBe("/website/download");
    expect(page("/website/docs/getting-started").path).toBe(
      "/website/docs/getting-started",
    );
  });

  test("returns a frozen copy", () => {
    const p = page("/website/apps");
    expect(Object.isFrozen(p)).toBe(true);
  });

  test.each([
    ["relative", "website/apps"],
    ["outside the base path", "/apps"],
    ["a sibling sharing the prefix", "/websites/apps"],
    ["a trailing slash", "/website/apps/"],
    ["the base path with a trailing slash", "/website/"],
    ["a param", "/website/:id"],
    ["a wildcard", "/website/*"],
    ["a keyed param", "/website/apps;view=x"],
    ["a query", "/website/apps?x=1"],
    ["a fragment", "/website/apps#top"],
    ["an empty segment", "/website//apps"],
    ["a dot segment", "/website/../agents"],
    ["upper case", "/website/Apps"],
  ])("refuses %s (%s)", (_, path) => {
    expect(() => page(path)).toThrow(WebsitePageError);
  });

  test("refuses an empty title or description", () => {
    expect(() =>
      defineWebsitePage({ path: "/website", title: " ", description: "D." }),
    ).toThrow(/empty title/);
    expect(() =>
      defineWebsitePage({ path: "/website", title: "T", description: "" }),
    ).toThrow(/empty description/);
  });
});

describe("websitePaneIdentity", () => {
  test("derives the route from the path, the landing page as the index", () => {
    expect(websitePaneIdentity("/website")).toEqual({
      id: "website-landing",
      segment: "",
      appIndex: true,
    });
    expect(websitePaneIdentity("/website/download")).toEqual({
      id: "website-download",
      segment: "download",
      appIndex: false,
    });
    expect(websitePaneIdentity("/website/a/b")).toEqual({
      id: "website-a-b",
      segment: "a/b",
      appIndex: false,
    });
  });
});
