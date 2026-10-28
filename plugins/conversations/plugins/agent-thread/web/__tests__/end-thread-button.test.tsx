/**
 * The thread's Close (×) is a predicted write (`useLiveMutation(dropAndExit)`):
 * a click hands back to the host (`onEnded`) at once — before the server has
 * answered — and the write still goes out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fakeFetchEndpoint } from "@plugins/infra/plugins/endpoints/web/testing";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { conversationsById } from "@plugins/tasks/plugins/tasks-core/core";
import { dropAndExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/core";
import { EndThreadButton } from "../components/end-thread-button";

afterEach(cleanup);

const ID = "conv-end-thread";

describe("EndThreadButton", () => {
  it("calls onEnded on the click, before the close is answered", async () => {
    // The server never answers within the test: nothing may wait for it.
    const fake = fakeFetchEndpoint(() => new Promise<unknown>(() => {}));
    const live = createLiveStateHarness({ transport: fake.transport });
    live.queryClient.setQueryData(
      queryKeyFor(conversationsById.rows.key, { ids: ID }),
      [{ id: ID, status: "waiting", workingOn: null }],
    );
    const onEnded = vi.fn();
    render(
      <live.Wrapper>
        <EndThreadButton conversationId={ID} onEnded={onEnded} />
      </live.Wrapper>,
    );
    // Enabled once the row has arrived (pending until then).
    const button = await waitFor(() => {
      const b = screen.getByRole<HTMLButtonElement>("button", {
        name: "Close",
      });
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(button);
    expect(onEnded).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]!.route).toBe(dropAndExit.route);
    expect(fake.calls[0]!.params).toEqual({ id: ID });
  });
});
