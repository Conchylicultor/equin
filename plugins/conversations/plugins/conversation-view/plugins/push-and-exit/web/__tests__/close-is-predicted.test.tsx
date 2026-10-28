/**
 * Close and Drop & Close are predicted writes (`useLiveMutation`): the
 * conversation reads `done` from the click — so the main button's mode, which
 * `deriveExitMode` takes from the by-id row (`useConversationById`), is
 * Restore BEFORE the server has answered. And Drop & Close's response-keyed
 * follow-up (the `dropped` toast) still runs on the answer.
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
import { exitConversation } from "@plugins/conversations/plugins/conversation-view/plugins/exit/core";
import { dropAndExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/core";
import { deriveExitMode } from "../components/exit-mode";

const ID = "conv-predicted-close";

/** The by-id row fields the exit decision reads; the rest play no part. */
const row = {
  id: ID,
  attemptId: "att-1",
  status: "waiting",
  workingOn: null,
  claudeSessionId: "s-1",
};

/** No turn is waiting for the agent to start. */
const NOT_AWAITING = {
  status: "ready",
  data: false,
  refetch: () => Promise.resolve(),
} as const;

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(answer: Promise<unknown>) {
  const fake = fakeFetchEndpoint(() => answer);
  const live = createLiveStateHarness({ transport: fake.transport });
  live.queryClient.setQueryData(
    queryKeyFor(conversationsById.rows.key, { ids: ID }),
    [row],
  );
  const onDropped = vi.fn();
  const hook = renderHook(
    () => {
      const conversation = useConversationById(ID);
      const close = useLiveMutation(exitConversation);
      const drop = useLiveMutation(dropAndExit, {
        onSuccess: (data) => onDropped(data.dropped),
      });
      const { mode } = deriveExitMode({
        conversation,
        live: conversation,
        draftEmpty: true,
        awaitingStart: NOT_AWAITING,
        exit: { workspace: "unknown" },
      });
      return { mode, close, drop };
    },
    { wrapper: live.Wrapper },
  );
  return { fake, hook, onDropped };
}

describe("Close / Drop & Close are predicted", () => {
  it("Close: the button reads Restore before the endpoint resolves", async () => {
    const answer = deferred();
    const { fake, hook } = setup(answer.promise);
    expect(hook.result.current.mode).not.toBe("restore");
    act(() => {
      const c = hook.result.current.close;
      if (c.kind === "unavailable") throw new Error(c.message);
      c.mutate({ params: { id: ID } });
    });
    expect(hook.result.current.mode).toBe("restore");
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(exitConversation.route);
    // Still Restore once the server answers (never-revert).
    await act(async () => {
      answer.resolve(undefined);
      await answer.promise;
    });
    expect(hook.result.current.mode).toBe("restore");
  });

  it("Drop & Close: Restore at once, the dropped-keyed follow-up on the answer", async () => {
    const answer = deferred();
    const { fake, hook, onDropped } = setup(answer.promise);
    act(() => {
      const d = hook.result.current.drop;
      if (d.kind === "unavailable") throw new Error(d.message);
      d.mutate({ params: { id: ID } });
    });
    expect(hook.result.current.mode).toBe("restore");
    expect(onDropped).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(dropAndExit.route);
    await act(async () => {
      answer.resolve({ ok: true, dropped: true });
      await answer.promise;
    });
    expect(onDropped).toHaveBeenCalledWith(true);
  });
});
