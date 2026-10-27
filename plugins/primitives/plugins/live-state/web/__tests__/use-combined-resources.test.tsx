/**
 * `useCombinedResources` keeps the identity its doc promises: the same input
 * results answer the same combined object across renders — even though every
 * render passes a fresh `{ a, b }` literal (this suite runs uncompiled, so no
 * React Compiler memo hides a miss) — and a changed input answers a new one.
 */

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCombinedResources } from "../resource-utils";
import type { ResourceResult } from "../use-resource";

const refetch = () => Promise.resolve();
const ready = <T,>(data: T): ResourceResult<T> => ({
  status: "ready",
  data,
  refetch,
});

describe("useCombinedResources", () => {
  it("answers the same object while the inputs are the same results", () => {
    const a = ready(1);
    const b = ready("x");
    const { result, rerender } = renderHook(
      (props: { a: ResourceResult<number>; b: ResourceResult<string> }) =>
        useCombinedResources({ a: props.a, b: props.b }),
      { initialProps: { a, b } },
    );
    const first = result.current;
    rerender({ a, b });
    expect(result.current).toBe(first);
  });

  it("answers a new object once an input result changes", () => {
    const a = ready(1);
    const { result, rerender } = renderHook(
      (props: { a: ResourceResult<number>; b: ResourceResult<string> }) =>
        useCombinedResources({ a: props.a, b: props.b }),
      { initialProps: { a, b: ready("x") } },
    );
    const first = result.current;
    rerender({ a, b: ready("y") });
    expect(result.current).not.toBe(first);
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.data.b).toBe("y");
  });

  it("keys the combine by its key names, not only by its inputs", () => {
    const r = ready(1);
    const { result: one } = renderHook(() => useCombinedResources({ a: r }));
    const { result: other } = renderHook(() => useCombinedResources({ b: r }));
    expect(other.current).not.toBe(one.current);
  });
});
