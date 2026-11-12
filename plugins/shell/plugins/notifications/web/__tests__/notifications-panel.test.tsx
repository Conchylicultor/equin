/**
 * The bell popover's chip row (by category) over `createLiveStateHarness` (a real client and its QueryClient)
 * (the live `use-live.test.tsx` harness): groupings are driven with
 * `client.setQueryData` on the exact tuple the codec encodes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// A developer's panel: its reads are the unscoped tuples seeded below.
vi.mock("@plugins/audience/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAudience: () => ({
    status: "ready",
    data: "developer",
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { queryKeyFor } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/network/plugins/live/plugins/live-state/web/testing";
import { notifications } from "../../shared/resources";
import { useState } from "react";
import {
  INITIAL_NOTIFICATIONS_FILTER,
  NotificationsBody,
  NotificationsHeader,
  type NotificationsFilter,
} from "../components/notifications-panel";

/** The popover's two halves over one filter, as the bell wires them. */
function Panel() {
  const [filter, setFilter] = useState<NotificationsFilter>(
    INITIAL_NOTIFICATIONS_FILTER,
  );
  return (
    <>
      <NotificationsHeader
        empty={false}
        filter={filter}
        onPick={setFilter}
        onClose={() => {}}
      />
      <NotificationsBody empty={false} filter={filter} onClose={() => {}} />
    </>
  );
}

afterEach(cleanup);

function mount(live: LiveStateHarness) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  return render(
    <live.Wrapper>
      <Panel />
    </live.Wrapper>,
  );
}

const groupsKey = (
  groupBy: "category" | "variant" | "stateTone",
  where?: { category: "reports" },
) =>
  queryKeyFor(
    `${notifications.key}:groups`,
    notifications.groups.groups.encode({
      groupBy,
      ...(where && { where }),
      limit: notifications.groups.groups.defaultLimit,
    }),
  );

describe("NotificationsPanel — chip row", () => {
  it("shows a loading state (never an empty row) while the groupings are pending", () => {
    mount(createLiveStateHarness());
    const chips = screen.getByTestId("notification-chips");
    expect(within(chips).getByRole("status").textContent).toContain(
      "Loading filters",
    );
    expect(within(chips).queryAllByRole("button")).toHaveLength(0);
  });

  it("chips are the user's categories (Reports / Other only when non-empty), with server counts", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    client.setQueryData(groupsKey("category"), [
      { value: "conversations", count: 3 },
      { value: "other", count: 2 },
    ]);
    client.setQueryData(groupsKey("variant"), [
      { value: "info", count: 4 },
      { value: "error", count: 1 },
    ]);
    mount(live);
    await waitFor(() => {
      const chips = screen.getByTestId("notification-chips");
      expect(
        within(chips)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([
        "All",
        "Errors 1",
        "Conversations 3",
        "Updates 0",
        "Automations 0",
        "Other 2",
      ]);
    });
  });

  it("a category whose rows carry states splits by where they stand, with server counts", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    client.setQueryData(groupsKey("category"), [
      { value: "reports", count: 10 },
    ]);
    client.setQueryData(groupsKey("variant"), [{ value: "error", count: 2 }]);
    client.setQueryData(groupsKey("stateTone", { category: "reports" }), [
      { value: null, count: 6 },
      { value: "resolved", count: 3 },
      { value: "recurred", count: 1 },
    ]);
    mount(live);
    const reports = await screen.findByRole("button", { name: /Reports/ });
    expect(screen.queryByTestId("notification-states")).toBeNull();
    fireEvent.click(reports);
    await waitFor(() => {
      const states = screen.getByTestId("notification-states");
      expect(
        within(states)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([
        "Any state",
        "Open 6",
        "Pending 0",
        "Resolved 3",
        "Came back 1",
      ]);
    });
  });

  it("a category none of whose rows carries a state has no state chips", async () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    client.setQueryData(groupsKey("category"), [
      { value: "reports", count: 4 },
    ]);
    client.setQueryData(groupsKey("variant"), [{ value: "error", count: 0 }]);
    client.setQueryData(groupsKey("stateTone", { category: "reports" }), [
      { value: null, count: 4 },
    ]);
    mount(live);
    fireEvent.click(await screen.findByRole("button", { name: /Reports/ }));
    await waitFor(() => {
      expect(
        client.getQueryData(groupsKey("stateTone", { category: "reports" })),
      ).toBeDefined();
    });
    expect(screen.queryByTestId("notification-states")).toBeNull();
  });
});
