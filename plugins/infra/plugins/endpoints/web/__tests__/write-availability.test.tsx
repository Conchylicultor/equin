/**
 * `useWriteAvailability`: a write the subtree may not send is unavailable
 * before it is sent — a desktop-only one on a transport without the computer,
 * and an owner-only one from a page its server took for a deployed site's
 * visitor (the boot snapshot's `caller`). The page's principal is recorded
 * once per page, so this file IS a visitor's page from its second test on.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  pagePrincipal,
  recordPagePrincipal,
} from "@plugins/framework/plugins/principal/web";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";
import { defineEndpoint } from "../../core";
import { useWriteAvailability } from "../internal/use-write-availability";

const ownerWrite = defineEndpoint({
  route: "POST /api/x/notes",
  body: z.object({ n: z.number() }),
});
const visitorWrite = defineEndpoint({
  route: "POST /api/x/emit",
  body: z.object({ n: z.number() }),
  access: { visitor: "a site's pages emit here" },
});
const machineWrite = defineEndpoint({
  route: "POST /api/x/launch",
  body: z.object({ n: z.number() }),
  needsMachine: { feature: "Launching" },
});

const page = transportWrapper(testTransport());
const inBrowser = transportWrapper(
  testTransport({ server: "in-browser", machine: false }),
);

function availability(
  endpoint: Parameters<typeof useWriteAvailability>[0],
  wrapper: typeof page,
) {
  return renderHook(() => useWriteAvailability(endpoint), { wrapper }).result
    .current;
}

describe("useWriteAvailability", () => {
  it("a page with no recorded principal leaves the decision to its server", () => {
    expect(pagePrincipal()).toBe("unknown");
    expect(availability(ownerWrite, page)).toEqual({ available: true });
  });

  it("a desktop-only write is unavailable without the computer", () => {
    const a = availability(machineWrite, inBrowser);
    expect(a.available).toBe(false);
  });

  it("a visitor's page may not send an owner-only write, and may send a visitor one", () => {
    recordPagePrincipal("visitor");
    const refused = availability(ownerWrite, page);
    expect(refused.available).toBe(false);
    if (!refused.available)
      expect(refused.message).toContain("POST /api/x/notes");
    expect(availability(visitorWrite, page)).toEqual({ available: true });
  });

  it("an in-browser server's caller is the page itself: its owner", () => {
    expect(pagePrincipal()).toBe("visitor");
    expect(
      availability(
        ownerWrite,
        transportWrapper(testTransport({ server: "in-browser" })),
      ),
    ).toEqual({ available: true });
  });

  it("a page's principal never changes", () => {
    expect(() => recordPagePrincipal("owner")).toThrow(/never changes/);
  });
});
