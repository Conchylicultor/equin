/**
 * The bell's badge reads the `notifications.unread` VALUE (a whole-table
 * count), not the loaded window: pending paints a neutral bell, settled paints
 * the count (label exact, badge capped at "9+") in red only while an error is
 * among them. Data is driven with `client.setQueryData` on the exact tuples.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { cleanup, render, screen } from "@testing-library/react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  type LiveStateHarness,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { notifications, notificationsUnread } from "../../shared/resources";
import { BellButton } from "../components/bell-button";

afterEach(cleanup);

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
