/**
 * The bell popover's chip row (by category) over `createLiveStateHarness` (a real client and its QueryClient)
 * (the live `use-live.test.tsx` harness): groupings are driven with
 * `client.setQueryData` on the exact tuple the codec encodes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// A developer's panel: its reads are the unscoped tuples seeded below.
vi.mock("@plugins/audience/web", () => ({
  useAudience: () => ({
    status: "ready",
    data: "developer",
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { notifications } from "../../shared/resources";
import { NotificationsPanel } from "../components/notifications-panel";

afterEach(cleanup);

function mount(live: LiveStateHarness) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  return render(
    <live.Wrapper>
      <NotificationsPanel empty={false} onClose={() => {}} />
    </live.Wrapper>,
  );
}

const groupsKey = (groupBy: "category" | "variant") =>
  queryKeyFor(
    `${notifications.key}:groups`,
    notifications.groups.groups.encode({
      groupBy,
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
});
