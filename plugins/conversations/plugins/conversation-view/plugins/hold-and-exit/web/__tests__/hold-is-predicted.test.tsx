/**
 * Hold & Close is a predicted write (`useLiveMutation`): the conversation
 * reads `done` from the click, before the server has answered.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { conversationsById } from "@plugins/tasks/plugins/tasks-core/core";
import { useConversationById } from "@plugins/conversations/web";
import { holdAndExit } from "../../shared";

const ID = "conv-predicted-hold";

describe("Hold & Close is predicted", () => {
  it("the conversation reads done before the endpoint resolves", async () => {
    let resolve!: (v: unknown) => void;
    const answer = new Promise<unknown>((res) => {
      resolve = res;
    });
    const fake = fakeFetchEndpoint(() => answer);
    const live = createLiveStateHarness({ transport: fake.transport });
    live.queryClient.setQueryData(
      queryKeyFor(conversationsById.rows.key, { ids: ID }),
      [{ id: ID, attemptId: "att-1", status: "waiting", workingOn: null }],
    );
    const hook = renderHook(
      () => ({
        conversation: useConversationById(ID),
        hold: useLiveMutation(holdAndExit),
      }),
      { wrapper: live.Wrapper },
    );
    const status = () => hook.result.current.conversation?.status;
    expect(status()).toBe("waiting");
    act(() => {
      const h = hook.result.current.hold;
      if (h.kind === "unavailable") throw new Error(h.message);
      h.mutate({ params: { id: ID } });
    });
    expect(status()).toBe("done");
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(holdAndExit.route);
    await act(async () => {
      resolve(undefined);
      await answer;
    });
    expect(status()).toBe("done");
  });
});
