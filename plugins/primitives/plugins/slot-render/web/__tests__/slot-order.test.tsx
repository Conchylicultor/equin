import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PluginProvider,
  type Contribution,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { defineRenderSlot } from "../internal/render-slot";
import { SlotRender } from "../internal/slots";
import { useSlotOrder } from "../internal/slot-order";

afterEach(cleanup);

/**
 * `useSlotOrder` answers a read: without a layout engine the registration order
 * is known at once (ready); with one, its answer — loading included — passes
 * through untouched, so a host can never draw the raw order in its place.
 */

type UseOrder = (
  slot: SlotHandle,
  contributions: readonly Contribution[],
) => ResourceResult<readonly Contribution[]>;

const loading: ResourceResult<readonly Contribution[]> = {
  status: "loading",
  refetch: () => Promise.resolve(),
};

function fixture(orders: UseOrder[]) {
  const slot = defineRenderSlot<{ label: string }>();
  const plugin = {
    id: "slot-order-test",
    description: "slot order fixture",
    contributions: [
      slot({ id: "a", label: "A" }),
      slot({ id: "b", label: "B" }),
      ...orders.map((useOrder) => SlotRender.Order({ useOrder } as never)),
    ],
    slots: { bar: slot },
  } as unknown as LoadedPlugin;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PluginProvider plugins={[plugin]}>{children}</PluginProvider>
  );
  return { slot, wrapper };
}

describe("useSlotOrder", () => {
  it("is ready in registration order with no Order contributed", () => {
    const { slot, wrapper } = fixture([]);
    const { result, rerender } = renderHook(() => useSlotOrder(slot), {
      wrapper,
    });
    const r = result.current;
    expect(r.status).toBe("ready");
    expect(r.status === "ready" ? r.data.map((c) => c.id) : []).toEqual([
      "a",
      "b",
    ]);
    rerender();
    expect(result.current).toBe(r);
  });

  it("passes a contributed order's loading arm through", () => {
    const useOrder = vi.fn<UseOrder>(() => loading);
    const { slot, wrapper } = fixture([useOrder]);
    const { result } = renderHook(() => useSlotOrder(slot), { wrapper });
    expect(result.current.status).toBe("loading");
    expect(useOrder).toHaveBeenCalled();
  });

  it("throws when more than one Order is contributed", () => {
    const useOrder: UseOrder = () => loading;
    const { slot, wrapper } = fixture([useOrder, useOrder]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSlotOrder(slot), { wrapper })).toThrow(
      /2 SlotRender.Order contributions/,
    );
  });
});
