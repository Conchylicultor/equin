/**
 * The bell's badge reads the `notifications.unread` VALUE (a whole-table
 * count), not the loaded window: pending paints a neutral bell, settled paints
 * the count (label exact, badge capped at "9+") in red only while an error is
 * among them. Data is driven with `client.setQueryData` on the exact tuples.
 *
 * Closing the popover after it opened with unread items marks all read — but
 * leaving through the panel's "View all" (to Debug → Notifications) does not:
 * it closes through `onClose`, never the popover's own `onOpenChange`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

const spy = vi.hoisted(() => ({
  /** Every `fetchEndpoint` call's route (the bell's mark-all-read). */
  fetched: [] as string[],
  /** Every app link opened. */
  opened: [] as string[],
}));

vi.mock("@plugins/infra/plugins/endpoints/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchEndpoint: (endpoint: { route: string }) => {
    spy.fetched.push(endpoint.route);
    return Promise.resolve();
  },
}));

vi.mock("@plugins/apps-core/plugins/tabs/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appLink: (url: string) => ({
    open: () => {
      spy.opened.push(url);
    },
    href: () => url,
  }),
}));

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { notifications, notificationsUnread } from "../../shared/resources";
import { BellButton } from "../components/bell-button";

afterEach(() => {
  cleanup();
  spy.fetched = [];
  spy.opened = [];
});

function mount(live: LiveStateHarness) {
  vi.spyOn(live.notifications, "hasEverBeenReady").mockReturnValue(true);
  return render(
    <live.Wrapper>
      <BellButton />
    </live.Wrapper>,
  );
}

const windowKey = () => {
  if (!notifications.window.defaultParams) {
    throw new Error("notifications window has no default tuple");
  }
  return queryKeyFor(notifications.key, notifications.window.defaultParams);
};
const unreadKey = () => queryKeyFor(notificationsUnread.key, {});

function settled(unread: {
  errors: number;
  warnings: number;
}): LiveStateHarness {
  const live = createLiveStateHarness();
  live.queryClient.setQueryData(windowKey(), []);
  live.queryClient.setQueryData(unreadKey(), unread);
  return live;
}

describe("BellButton — unread badge", () => {
  it("paints a neutral bell (no count) while the unread value is pending", () => {
    const live = createLiveStateHarness();
    const client = live.queryClient;
    client.setQueryData(windowKey(), []);
    mount(live);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByText(/^\d|9\+/)).toBeNull();
  });

  it("labels the exact count, caps the badge at 9+, and is red with an error", () => {
    mount(settled({ errors: 3, warnings: 250 }));
    expect(
      screen.getByRole("button", { name: "Notifications, 253 unread" }),
    ).toBeTruthy();
    const badge = screen.getByText("9+");
    // The solid fill (deep red, light figures in the chrome), not the bright
    // `destructive` the chrome keeps for text.
    expect(badge.className).toContain("bg-destructive-solid");
    expect(badge.className).toContain("text-destructive-solid-foreground");
  });

  it("is amber (the solid warning fill) when only warnings are unread", () => {
    mount(settled({ errors: 0, warnings: 2 }));
    expect(
      screen.getByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeTruthy();
    expect(screen.getByText("2").className).toContain("bg-warning-solid");
  });

  it("shows no badge at zero", () => {
    mount(settled({ errors: 0, warnings: 0 }));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("BellButton — leaving the popover", () => {
  const MARK_ALL_READ = "POST /api/notifications/mark-all-read";

  async function openPopover() {
    mount(settled({ errors: 1, warnings: 0 }));
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    );
    // The panel mounts only while open.
    return waitFor(() => screen.getByText("View all"));
  }

  it("View all opens Debug → Notifications and closes without marking read", async () => {
    fireEvent.click(await openPopover());
    expect(spy.opened).toEqual(["/debug/notifications"]);
    await waitFor(() => {
      expect(screen.queryByText("View all")).toBeNull();
    });
    expect(spy.fetched).not.toContain(MARK_ALL_READ);
  });

  it("dismissing the popover itself (Escape) marks all read", async () => {
    await openPopover();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => {
      expect(spy.fetched).toContain(MARK_ALL_READ);
    });
  });
});
