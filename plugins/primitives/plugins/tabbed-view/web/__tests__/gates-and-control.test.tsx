/**
 * The tab host's per-tab hooks and its controlled mode: a tab whose
 * `useAvailable` answers false is not in the strip and an active id naming it
 * falls back to the first available tab; `useBadge` draws a count after the
 * title; a controlled host shows the tab its caller names and reports a pick
 * through `onActiveChange` without moving on its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineTabbedView } from "../internal/define-tabbed-view";

interface Props {
  siteId: string;
}

const tabs = defineTabbedView<Props>("tabbed-view-gates-test", {
  strip: "underline",
});
const icon = symbol("add");

/** What the gated / badged tabs answer; tests flip them between renders. */
const state = {
  messagesAvailable: true,
  unread: null as number | null,
  /** The siteId each gate saw — proves the hooks get the host's view props. */
  seen: [] as string[],
};

const plugins = [
  {
    id: "tabbed-view-gates-test",
    description: "three tabs, one gated and badged",
    slots: { view: tabs.View },
    contributions: [
      tabs.View({
        id: "overview",
        title: "Overview",
        icon,
        component: ({ siteId }: Props) => <p>overview of {siteId}</p>,
      }),
      tabs.View({
        id: "messages",
        title: "Messages",
        icon,
        component: () => <p>messages body</p>,
        useAvailable: ({ siteId }: Props) => {
          state.seen.push(siteId);
          return state.messagesAvailable;
        },
        useBadge: () =>
          state.unread === null ? null : { count: state.unread },
      }),
      tabs.View({
        id: "settings",
        title: "Settings",
        icon,
        component: () => <p>settings body</p>,
      }),
    ],
  },
  {
    id: "tabbed-view-gates-test-order",
    description: "registration order, ready",
    contributions: [
      SlotRender.Order({
        useOrder: (_slot, contributions) => ({
          status: "ready" as const,
          data: contributions,
          refetch: () => Promise.resolve(),
        }),
      }),
    ],
  },
] as unknown as LoadedPlugin[];

function wrap(node: ReactNode) {
  return <PluginProvider plugins={plugins}>{node}</PluginProvider>;
}

afterEach(() => {
  cleanup();
  state.messagesAvailable = true;
  state.unread = null;
  state.seen = [];
  localStorage.clear();
});

describe("a controlled tab host", () => {
  it("shows the tab its caller names, and reports a pick without moving", () => {
    const onActiveChange = vi.fn();
    const { rerender } = render(
      wrap(
        <tabs.Host
          siteId="s1"
          activeId="settings"
          onActiveChange={onActiveChange}
        />,
      ),
    );
    expect(screen.getByText("settings body")).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Settings" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Overview" }));
    expect(onActiveChange).toHaveBeenCalledWith("overview");
    // Still the caller's tab until the caller moves it.
    expect(screen.getByText("settings body")).toBeTruthy();

    rerender(
      wrap(
        <tabs.Host
          siteId="s1"
          activeId="overview"
          onActiveChange={onActiveChange}
        />,
      ),
    );
    expect(screen.getByText("overview of s1")).toBeTruthy();
    // A controlled host never writes the device-local store.
    expect(localStorage.length).toBe(0);
  });

  it("shows the first tab when its caller names none", () => {
    render(
      wrap(
        <tabs.Host
          siteId="s1"
          activeId={undefined}
          onActiveChange={() => {}}
        />,
      ),
    );
    expect(screen.getByText("overview of s1")).toBeTruthy();
  });
});

describe("an unavailable tab", () => {
  it("is not in the strip, and an active id naming it falls back to the first available tab", () => {
    state.messagesAvailable = false;
    render(
      wrap(
        <tabs.Host siteId="s1" activeId="messages" onActiveChange={() => {}} />,
      ),
    );
    expect(screen.queryByRole("radio", { name: /Messages/ })).toBeNull();
    expect(screen.getByRole("radio", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByText("messages body")).toBeNull();
    expect(screen.getByText("overview of s1")).toBeTruthy();
    expect(state.seen).toContain("s1");
  });

  it("comes back when its gate opens", () => {
    state.messagesAvailable = false;
    const { rerender } = render(
      wrap(
        <tabs.Host siteId="s1" activeId="messages" onActiveChange={() => {}} />,
      ),
    );
    expect(screen.getByText("overview of s1")).toBeTruthy();

    state.messagesAvailable = true;
    rerender(
      wrap(
        <tabs.Host siteId="s2" activeId="messages" onActiveChange={() => {}} />,
      ),
    );
    expect(screen.getByText("messages body")).toBeTruthy();
  });

  it("falls back the same way in an uncontrolled host", () => {
    state.messagesAvailable = false;
    render(wrap(<tabs.Host siteId="s1" />));
    expect(screen.getByText("overview of s1")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });
});

describe("a tab badge", () => {
  it("draws its count after the title, and nothing for null", () => {
    const { rerender } = render(
      wrap(
        <tabs.Host
          siteId="s1"
          activeId={undefined}
          onActiveChange={() => {}}
        />,
      ),
    );
    const messages = screen.getByRole("radio", { name: "Messages" });
    expect(messages.textContent).toBe("Messages");

    state.unread = 2;
    rerender(
      wrap(
        <tabs.Host
          siteId="s2"
          activeId={undefined}
          onActiveChange={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("radio", { name: /Messages/ }).textContent).toBe(
      "Messages2",
    );
  });
});
