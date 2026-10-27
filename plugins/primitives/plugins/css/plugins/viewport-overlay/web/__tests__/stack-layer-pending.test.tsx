/**
 * A stack-layer overlay while the stack order is not known yet: nothing is
 * drawn (no portal, no guessed z-index), and once the order is known the
 * overlay mounts at its index — the portal's first mount, never a toggle.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlotRender } from "@plugins/primitives/plugins/slot-render/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { defineZLayer } from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web";
import { ZStack } from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web/testing";
import { ViewportOverlay } from "../internal/viewport-overlay";

const below = defineZLayer({ id: "below", label: "a layer under" });
const layer = defineZLayer({ id: "probe", label: "the layer under test" });

/** What the fake layout engine answers; `null` = ready, in registration order. */
const order = { current: null as ResourceResult<never> | null };

const plugins = [
  {
    id: "primitives.css.z-layers.stack",
    description: "the stack, with two layers",
    slots: ZStack,
    contributions: [below.contribution, layer.contribution],
  },
  {
    id: "stack-layer-pending-test-order",
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

function overlay() {
  return (
    <PluginProvider plugins={plugins}>
      <ViewportOverlay layer={layer}>
        <p data-testid="overlay-content">content</p>
      </ViewportOverlay>
    </PluginProvider>
  );
}

afterEach(() => {
  cleanup();
  order.current = null;
});

describe("a stack-layer overlay", () => {
  it("draws nothing until the stack order is known, then mounts at its index", () => {
    order.current = { status: "loading", refetch: () => Promise.resolve() };
    const { rerender } = render(overlay());
    expect(
      document.querySelector('[data-testid="overlay-content"]'),
    ).toBeNull();

    order.current = null;
    rerender(overlay());
    const content = document.querySelector('[data-testid="overlay-content"]');
    expect(content).not.toBeNull();
    // Second on the stack: popover (50) + 1 + position 1.
    const root = content!.closest<HTMLElement>(".fixed");
    expect(root?.style.zIndex).toBe("52");
  });
});
