/**
 * "Show tips again" is a predicted write: the named seen rows leave the
 * hints.seen collection from the call, before the server has answered, and
 * `onReset` (the confirmation toast) runs only when it has.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { hintsSeen, resetHintsEndpoint } from "../../core";
import { useResetHints } from "../internal/seen";

describe("useResetHints is predicted", () => {
  it("the seen row is gone before the answer; onReset follows it", async () => {
    let resolve!: (v: unknown) => void;
    const answer = new Promise<unknown>((res) => {
      resolve = res;
    });
    const fake = fakeFetchEndpoint(() => answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    live.queryClient.setQueryData(
      queryKeyFor(hintsSeen.rows.key, { ids: "tip-a" }),
      [{ hintId: "tip-a", outcome: "dismissed", seenAt: new Date(0) }],
    );
    const onReset = vi.fn();
    const hook = renderHook(
      () => ({
        row: useLiveRow(hintsSeen, "tip-a"),
        reset: useResetHints(onReset),
      }),
      { wrapper: live.Wrapper },
    );
    const found = () => {
      const r = hook.result.current.row;
      if (r.status !== "ready") throw new Error(`got ${r.status}`);
      return r.found;
    };
    expect(found()).toBe(true);
    act(() => hook.result.current.reset(["tip-a"]));
    expect(found()).toBe(false);
    expect(onReset).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(resetHintsEndpoint.route);
    await act(async () => {
      resolve(undefined);
      await answer;
    });
    // (An applyRows target retires at the ack: the server's own push of the
    // removal is what keeps the row gone from then on.)
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });
});
