/**
 * Per-key replay floors (`ReplayScope`): the L2 boot catch-up replays every
 * changelog row since the OLDEST persisted row's position, but a persisted
 * key's `{}` value already reflects every transaction below ITS OWN row's
 * position (the xmin of the read it came from). So a replayed change whose xid
 * is below that key's floor skips the key's `{}` — and only it: a key with no
 * floor, a non-persisted entry, and a live change (no scope) route as before.
 * The boundary is `xid >= floor` routes, exactly the changelog select's own.
 * See research/2026-10-30-global-boot-catch-up-per-key-floors.md.
 */

import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { createHarness, tick } from "./test-support";
import { wholeReach } from "./testing/routed-fixture";
import type { ReplayScope, TableChange } from "./routing";

const schema = z.array(z.object({ id: z.string() }));

// Two param-less values reading `t` whole: `p` persisted, `q` not.
function replayHarness() {
  const loads: string[] = [];
  const h = createHarness({
    shouldPersist: (k) => k === "p",
    captureWatermark: async () => "1",
    persistSnapshot: async () => {},
  });
  for (const key of ["p", "q"]) {
    h.runtime.defineResource(
      { key, schema, validateParams: () => {} },
      {
        mode: "push",
        reach: wholeReach(["t"]),
        loader: () => {
          loads.push(key);
          return [{ id: "a" }];
        },
      },
    );
  }
  const change: TableChange = {
    source: "feed",
    table: "t",
    op: "U",
    ids: ["a"],
    keys: null,
    unchanged: null,
  };
  const replay = (xid: string, floors: Record<string, string>): void => {
    const scope: ReplayScope = { xid, floors: new Map(Object.entries(floors)) };
    h.runtime.routeTableChange(change, scope);
  };
  return { h, loads, change, replay };
}

async function replaySkipsOf(
  h: ReturnType<typeof createHarness>,
  key: string,
): Promise<number> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const body = (await res.json()) as {
    resources: Array<{ key: string; replaySkips: number }>;
  };
  return body.resources.find((r) => r.key === key)!.replaySkips;
}

describe("replay floors", () => {
  test("a replayed change below a persisted key's floor does not recompute it", async () => {
    const { h, loads, replay } = replayHarness();
    replay("99", { p: "100" });
    await tick();
    expect(loads).toEqual([]);
    expect(await replaySkipsOf(h, "p")).toBe(1);
  });

  test("the boundary: a change AT the floor recomputes (the floor's own transaction is not reflected)", async () => {
    const { loads, replay } = replayHarness();
    replay("100", { p: "100" });
    await tick();
    expect(loads).toEqual(["p"]);
  });

  test("a change above the floor recomputes", async () => {
    const { loads, replay } = replayHarness();
    replay("101", { p: "100" });
    await tick();
    expect(loads).toEqual(["p"]);
  });

  test("xids compare as numbers, never as strings", async () => {
    const { loads, replay } = replayHarness();
    replay("1000", { p: "999" }); // "1000" < "999" as text
    await tick();
    expect(loads).toEqual(["p"]);
  });

  test("a persisted key with no floor (recomputed at boot) is routed every replayed change", async () => {
    const { loads, replay } = replayHarness();
    replay("5", {});
    await tick();
    expect(loads).toEqual(["p"]);
  });

  test("a live change (no scope) routes whatever its xid", async () => {
    const { h, loads, change } = replayHarness();
    h.runtime.routeTableChange({ ...change, xid: "5" });
    await tick();
    expect(loads).toEqual(["p"]);
  });

  test("a non-persisted entry is never skipped, even under a floor named for it", async () => {
    const { h, loads, replay } = replayHarness();
    await h.subscribe("q", {});
    loads.length = 0;
    replay("5", { p: "100", q: "100" });
    await tick();
    expect(loads).toEqual(["q"]);
  });

  test("a tab subscribed to the persisted `{}` is skipped with it: whatever it holds was read at or after the floor", async () => {
    const { h, loads, replay } = replayHarness();
    await h.subscribe("p", {});
    loads.length = 0;
    const frames = h.frames.length;
    replay("99", { p: "100" });
    await tick();
    expect(loads).toEqual([]);
    expect(h.frames).toHaveLength(frames);
    // …and the next change at or above it still reaches the tab.
    replay("100", { p: "100" });
    await tick();
    expect(loads).toEqual(["p"]);
  });
});
