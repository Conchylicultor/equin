/**
 * The tab host while its tabs' layout order is not known yet: the caller's
 * header is already there (no switcher — which tabs exist, in which order, is
 * exactly what is not known), the body is a loading state, and the header is
 * the SAME DOM node once the order settles — never the tabs in raw
 * registration order first.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineTabbedView } from "../internal/define-tabbed-view";

const tabs = defineTabbedView<object>("tabbed-view-pending-test");
const icon = symbol("add");

/** What the fake layout engine answers; `null` = ready, in registration order. */
const order = { current: null as ResourceResult<never> | null };

const plugins = [
  {
    id: "tabbed-view-pending-test",
    description: "two tabs",
    slots: { view: tabs.View },
    contributions: [
      tabs.View({
        id: "a",
        title: "Alpha",
        icon,
        component: () => <p>alpha body</p>,
      }),
      tabs.View({
        id: "b",
        title: "Beta",
        icon,
        component: () => <p>beta body</p>,
      }),
    ],
  },
  {
    id: "tabbed-view-pending-test-order",
    description: "a layout engine the test drives",
    contributions: [
      SlotRender.Order({
        useOrder: (_slot, contributions) =>
          order.current ?? {
            status: "ready" as const,
            data: contributions,
            refetch: () => Promise.resolve(),
          },
      }),
    ],
  },
] as unknown as LoadedPlugin[];

function host() {
  return (
    <PluginProvider plugins={plugins}>
      <tabs.Host header={<h2>The header</h2>} />
    </PluginProvider>
  );
}

afterEach(() => {
  cleanup();
  order.current = null;
});

describe("a tab host whose order is not known yet", () => {
  it("keeps its header, shows a loading body, then settles without remounting the header", () => {
    order.current = { status: "loading", refetch: () => Promise.resolve() };
    const { container, rerender } = render(host());

    const header = screen.getByText("The header");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("alpha body")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();

    order.current = null;
    rerender(host());

    expect(screen.getByText("The header")).toBe(header);
    expect(screen.getByText("alpha body")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
