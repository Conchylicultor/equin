import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installStorage,
  QuotaStorage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web/testing";
import {
  flushKept,
  KeepScope,
} from "@plugins/primitives/plugins/kept-state/web";
import { useCollapsible } from "../internal/use-collapsible";
import { useExpandAll } from "../internal/use-expand-all";

beforeAll(() => {
  installStorage("local", new QuotaStorage());
  installStorage("session", new QuotaStorage());
});
afterEach(cleanup);

let n = 0;
function inPlace(segment: string) {
  return ({ children }: { children: ReactNode }) => (
    <KeepScope segment="t:tab">
      <KeepScope segment={segment}>{children}</KeepScope>
    </KeepScope>
  );
}

describe("a kept collapsible", () => {
  it("gives its open state back on a remount of the same place", () => {
    const wrapper = inPlace(`p:${++n}`);
    const a = renderHook(() => useCollapsible({ keep: "details" }), {
      wrapper,
    });
    act(() => a.result.current.toggle());
    expect(a.result.current.open).toBe(true);
    a.unmount();
    flushKept();

    const again = renderHook(() => useCollapsible({ keep: "details" }), {
      wrapper,
    });
    expect(again.result.current.open).toBe(true);
    const other = renderHook(() => useCollapsible({ keep: "other" }), {
      wrapper,
    });
    expect(other.result.current.open).toBe(false);
  });

  it("is not kept without `keep`, nor when controlled", () => {
    const wrapper = inPlace(`p:${++n}`);
    const a = renderHook(() => useCollapsible(), { wrapper });
    act(() => a.result.current.toggle());
    a.unmount();
    flushKept();
    expect(
      renderHook(() => useCollapsible(), { wrapper }).result.current.open,
    ).toBe(false);

    const controlled = renderHook(
      () => useCollapsible({ open: false, keep: "c" }),
      { wrapper },
    );
    act(() => controlled.result.current.toggle());
    controlled.unmount();
    flushKept();
    expect(
      renderHook(() => useCollapsible({ keep: "c" }), { wrapper }).result
        .current.open,
    ).toBe(false);
  });
});

describe("useExpandAll", () => {
  it("keeps the expanded ids under its key", () => {
    const wrapper = inPlace(`p:${++n}`);
    const ids = ["a", "b"];
    const a = renderHook(() => useExpandAll(ids, { keep: "files" }), {
      wrapper,
    });
    act(() => a.result.current.toggle("b"));
    a.unmount();
    flushKept();
    const again = renderHook(() => useExpandAll(ids, { keep: "files" }), {
      wrapper,
    });
    expect([...again.result.current.expanded]).toEqual(["b"]);
    act(() => again.result.current.toggleAll());
    expect(again.result.current.allExpanded).toBe(true);
  });
});
