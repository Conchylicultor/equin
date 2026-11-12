// A page that unloads before its lists settle must still leave its page load:
// it is the only trace a tab reloading faster than it loads leaves.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Interaction } from "../../core";
import {
  cutActiveInteraction,
  startInteractionTracking,
} from "../internal/interaction-tracker";

let pending = 1;
vi.mock(
  "@plugins/network/plugins/live/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    pendingMountSnapshot: () => ({
      pending,
      startedTotal: 3,
      pendingKeys: ["tasks"],
      lastReleasedKey: null,
    }),
    subscribePendingMounts: () => () => {},
  }),
);
vi.mock("@plugins/primitives/plugins/pane/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentRoutePath: () => "/demo",
}));
vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  pending = 1;
});

describe("cutActiveInteraction", () => {
  it("records an unsettled page load as censored", () => {
    const seen: Interaction[] = [];
    stop = startInteractionTracking((i) => seen.push(i));
    expect(seen).toEqual([]);
    cutActiveInteraction();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "page-load",
      route: "/demo",
      censored: true,
    });
    // Once recorded, a second cut records nothing more.
    cutActiveInteraction();
    expect(seen).toHaveLength(1);
  });
});
