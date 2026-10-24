/**
 * `assetUrlOver`: a sink that loads by URL on its own gets the path on a
 * server a URL reaches, `unavailable` for a desktop-only route on a transport
 * without the computer — and a throw for a portable route on a transport no
 * URL reaches (there is no blob fallback for such a sink).
 */

import { describe, expect, it } from "vitest";
import { testTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { assetBase, assetPath, blob, defineEndpoint } from "../../core";
import { assetUrlOver } from "../internal/asset-url";

const getFile = defineEndpoint({
  route: "GET /api/files/:id",
  response: blob(),
});
const getMirrored = defineEndpoint({
  route: "GET /api/mirror/:id/:file",
  response: blob(),
  needsMachine: { feature: "The mirror" },
});
const inBrowser = testTransport({ servesUrls: false, machine: false });

describe("assetUrlOver", () => {
  it("is the path itself where a URL reaches the server", () => {
    expect(
      assetUrlOver(testTransport(), assetPath(getFile, { id: "a" })),
    ).toEqual({ kind: "ready", url: "/api/files/a" });
    expect(
      assetUrlOver(testTransport(), assetBase(getMirrored, { id: "m" })),
    ).toEqual({ kind: "ready", url: "/api/mirror/m" });
  });

  it("is unavailable for a desktop-only route without the computer", () => {
    expect(
      assetUrlOver(inBrowser, assetBase(getMirrored, { id: "m" })),
    ).toEqual({
      kind: "unavailable",
      message:
        "The mirror isn't available in this version of the app — it needs Singularity running on your computer.",
    });
  });

  it("throws for a portable route on a transport no URL reaches", () => {
    expect(() =>
      assetUrlOver(inBrowser, assetPath(getFile, { id: "a" })),
    ).toThrow("this transport serves no URL");
  });
});
