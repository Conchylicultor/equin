/**
 * `DependsOnEntry.toSubscribed`: a cascade that reaches every currently
 * subscribed tuple of the downstream — the runtime's own subscription state,
 * in place of a hand-kept active set read back by a `map`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createHarness } from "./test-support";

const S = z.object({ n: z.number() });

describe("dependsOn toSubscribed", () => {
  test("reaches every subscribed tuple and none that unsubscribed, without loading the upstream", async () => {
    const h = createHarness();
    let upstreamLoads = 0;
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: S,
      loader: () => ({ n: ++upstreamLoads }),
    });
    const loaded: string[] = [];
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: S,
      dependsOn: [{ resource: up, toSubscribed: true }],
      loader: ({ id }: { id: string }) => {
        loaded.push(id);
        return { n: loaded.length };
      },
    });
    await h.subscribe("down", { id: "a" });
    await h.subscribe("down", { id: "b" });
    await h.subscribe("down", { id: "c" });
    await h.unsub("down", { id: "c" });
    loaded.length = 0;

    up.notify({ ref: "main" });
    await h.tick();
    await h.tick();
    expect([...loaded].sort()).toEqual(["a", "b"]);
    // Nobody subscribes to the upstream and no edge reads its value.
    expect(upstreamLoads).toBe(0);
  });

  test("is exclusive with map", () => {
    const h = createHarness();
    const up = h.runtime.defineExternalResource({
      key: "up2",
      mode: "push",
      schema: S,
      loader: () => ({ n: 0 }),
    });
    expect(() =>
      h.runtime.defineResource({
        key: "down2",
        mode: "push",
        schema: S,
        dependsOn: [{ resource: up, toSubscribed: true, map: () => [{}] }],
        loader: () => ({ n: 0 }),
      }),
    ).toThrow(/both "map" and "toSubscribed"/);
  });
});
