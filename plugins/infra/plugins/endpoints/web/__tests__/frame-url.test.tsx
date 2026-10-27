/**
 * `frameUrlOver`: a frame document's URL is the asset's path behind the
 * transport's frame base — the page's own (`""`) or an in-browser server's
 * scoped prefix — `unavailable` for a desktop-only route without the
 * computer, and `unsupported` where nothing serves frames by URL.
 */

import { describe, expect, it } from "vitest";
import { testTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { assetBase, assetPath, blob, defineEndpoint } from "../../core";
import { frameUrlOver } from "../internal/frame-url";

const getPage = defineEndpoint({
  route: "GET /api/pages/:id/:file",
  response: blob(),
});
const getMirrored = defineEndpoint({
  route: "GET /api/mirror/:id/:file",
  response: blob(),
  needsMachine: { feature: "The mirror" },
});
const page = assetPath(getPage, { id: "a b", file: "index.html" });

describe("frameUrlOver", () => {
  it("is the path itself on the page's own server", () => {
    expect(frameUrlOver(testTransport(), page)).toEqual({
      kind: "ready",
      url: "/api/pages/a%20b/index.html",
    });
  });

  it("is the path behind an in-browser server's frame base", () => {
    const scoped = testTransport({
      servesUrls: false,
      machine: false,
      frameBase: "/artifacts/host-x/frames/sid",
    });
    expect(frameUrlOver(scoped, page)).toEqual({
      kind: "ready",
      url: "/artifacts/host-x/frames/sid/api/pages/a%20b/index.html",
    });
  });

  it("is unavailable for a desktop-only route without the computer", () => {
    const scoped = testTransport({
      servesUrls: false,
      machine: false,
      frameBase: "/artifacts/host-x/frames/sid",
    });
    expect(frameUrlOver(scoped, assetBase(getMirrored, { id: "m" }))).toEqual({
      kind: "unavailable",
      message:
        "The mirror isn't available in this version of the app — it needs equin running on your computer.",
    });
  });

  it("is unsupported where nothing serves frames by URL", () => {
    const noFrames = testTransport({
      servesUrls: false,
      machine: false,
      frameBase: null,
    });
    const url = frameUrlOver(noFrames, page);
    expect(url.kind).toBe("unsupported");
  });
});
