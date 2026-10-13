/**
 * What a landing costs React, measured in commits over a real
 * NotificationsProvider + the app's default QueryClient, outside `act` (which
 * would batch everything itself and hide the scheduler):
 *
 *   - a burst of first values — one cache write per tuple, as one WS frame per
 *     sub-ack makes on a cold page — renders in ONE commit, each reader once
 *     (`internal/coalesced-notify.ts`), never one commit per frame;
 *   - a value landing on one tuple re-renders that tuple's reader only: the
 *     other readers of the resource (other tuples) do not render.
 *
 * Values are written with `hydrateResource`, the same `setQueryData` on the
 * exact tuple a sub-ack makes, each its own cache write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { render } from "@testing-library/react";
import { memo, Profiler } from "react";
import { z } from "zod";
import {
  NotificationsProvider,
  ensureNotificationsClient,
  hydrateResource,
  useResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

const rowResource: ResourceDescriptor<number[], { id: string }> = {
  key: "test.landing-commits.row",
  schema: z.array(z.number()),
  validateParams: () => {},
};

const IDS = Array.from({ length: 20 }, (_, i) => `r${i}`);

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Let the scheduled notifications run and React commit what they caused. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("a landing's React cost", () => {
  let previousActEnv: boolean | undefined;
  beforeEach(() => {
    previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
  });
  afterEach(() => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
    vi.restoreAllMocks();
  });

  it("a burst of first values is one commit, and a later landing renders only its own reader", async () => {
    // No cold-start HTTP prime: the values come from the writes below.
    vi.spyOn(ensureNotificationsClient(), "hasEverBeenReady").mockReturnValue(
      true,
    );
    const renders = new Map<string, number>();
    const statuses = new Map<string, string>();
    let commits = 0;
    const Reader = memo(function Reader({ id }: { id: string }) {
      const r = useResource(rowResource, { id });
      renders.set(id, (renders.get(id) ?? 0) + 1);
      statuses.set(id, r.status);
      return null;
    });
    render(
      <NotificationsProvider>
        <Profiler id="readers" onRender={() => (commits += 1)}>
          {IDS.map((id) => (
            <Reader key={id} id={id} />
          ))}
        </Profiler>
      </NotificationsProvider>,
    );
    await settle();
    expect([...statuses.values()].every((s) => s === "loading")).toBe(true);

    // Outside `act`, so React schedules (and batches) as it does in the app.
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;

    const before = new Map(renders);
    commits = 0;
    for (const id of IDS) hydrateResource(rowResource, { id }, [1]);
    await settle();
    expect(commits).toBe(1);
    for (const id of IDS) {
      expect(renders.get(id)! - before.get(id)!).toBe(1);
      expect(statuses.get(id)).toBe("ready");
    }

    const settled = new Map(renders);
    commits = 0;
    hydrateResource(rowResource, { id: "r3" }, [2]);
    await settle();
    expect(commits).toBe(1);
    const rendered = IDS.filter((id) => renders.get(id) !== settled.get(id));
    expect(rendered).toEqual(["r3"]);
  });
});
