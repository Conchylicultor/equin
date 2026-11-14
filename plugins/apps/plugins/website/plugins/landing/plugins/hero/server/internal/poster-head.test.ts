import { describe, expect, test } from "bun:test";
import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";
import { landingPage } from "@plugins/apps/plugins/website/plugins/shell/core";
import { renderPosterHead } from "./poster-head";

const vision = defineWebsitePage({
  path: "/about/vision",
  title: "Vision",
  description: "Where equin is going.",
});

describe("renderPosterHead", () => {
  test("only the landing page preloads the poster; every other page has its own empty key", () => {
    // A head key covers its path and everything under it (longest match), so
    // /about/vision's own "" is what keeps it from inheriting /about's preload.
    expect(renderPosterHead([landingPage, vision], "<link>")).toEqual({
      "/about": "<link>",
      "/about/vision": "",
    });
  });
});
