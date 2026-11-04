/**
 * `assetUrlOver`: a sink that loads by URL on its own gets the path on a
 * server a URL reaches, `unavailable` for a desktop-only route on a transport
 * without the computer — and `fetch-only` for a portable route on a transport
 * no URL reaches (there is no blob fallback for such a sink).
 */

import { describe, expect, it } from "vitest";
import { testTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { assetBase, assetPath, blob, defineEndpoint } from "../../core";
import { assetFetchOver, assetUrlOver } from "../internal/asset-url";

const getFile = defineEndpoint({
  route: "GET /api/files/:id",
  response: blob(),
});
const getMirrored = defineEndpoint({
  route: "GET /api/mirror/:id/:file",
  response: blob(),
  needsMachine: { feature: "The mirror" },
});
const getNested = defineEndpoint({
  route: "GET /api/files/:id/:file",
  response: blob(),
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
        "The mirror isn't available in this version of the app — it needs equin running on your computer.",
    });
  });

  it("is fetch-only for a portable route on a transport no URL reaches", () => {
    expect(assetUrlOver(inBrowser, assetPath(getFile, { id: "a" }))).toEqual({
      kind: "fetch-only",
    });
  });
});

describe("assetFetchOver", () => {
  it("fetches under the asset's base over the transport", async () => {
    const seen: string[] = [];
    const transport = testTransport({
      servesUrls: false,
      machine: false,
      fetch: async (input) => {
        seen.push(String(input));
        return new Response("ok");
      },
    });
    const at = assetFetchOver(transport, assetBase(getNested, { id: "a" }));
    if (at.kind !== "ready") throw new Error("expected ready");
    expect(at.base).toBe("/api/files/a");
    expect(await (await at.fetch("/api/files/a/x.ogg")).text()).toBe("ok");
    expect(seen).toEqual(["/api/files/a/x.ogg"]);
    await expect(at.fetch("/api/other")).rejects.toThrow(
      "not under this asset's path",
    );
  });

  it("is unavailable for a desktop-only route without the computer", () => {
    expect(
      assetFetchOver(inBrowser, assetBase(getMirrored, { id: "m" })).kind,
    ).toBe("unavailable");
  });
});
