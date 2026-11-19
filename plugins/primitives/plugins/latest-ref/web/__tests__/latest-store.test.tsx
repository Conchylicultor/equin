import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { memo, useLayoutEffect, type ReactNode } from "react";
import {
  useLatestSelector,
  useLatestStore,
  type LatestStore,
} from "../internal/latest-store";

/**
 * The store a list hands its memoized rows: a row re-renders only when its own
 * answer changes, and a row mounting in the very render that changed the
 * value shows the new answer before paint (it subscribes in a layout effect,
 * ahead of the publisher's).
 */

afterEach(cleanup);

type State = { selected: string };

const renders: Record<string, number> = {};

const Row = memo(function Row({
  id,
  state,
}: {
  id: string;
  state: LatestStore<State>;
}): ReactNode {
  // Runs after every render of this row (no deps): its render count.
  useLayoutEffect(() => {
    renders[id] = (renders[id] ?? 0) + 1;
  });
  const selected = useLatestSelector(state, (s) => s.selected === id);
  return <span data-testid={id}>{selected ? "on" : "off"}</span>;
});

function List({ ids, selected }: { ids: string[]; selected: string }) {
  // A new object every render, as a host's per-render state is.
  const state = useLatestStore<State>({ selected });
  return (
    <>
      {ids.map((id) => (
        <Row key={id} id={id} state={state} />
      ))}
    </>
  );
}

describe("useLatestStore / useLatestSelector", () => {
  it("re-renders only the rows whose answer changed", () => {
    for (const k of Object.keys(renders)) delete renders[k];
    const { getByTestId, rerender } = render(
      <List ids={["a", "b", "c"]} selected="a" />,
    );
    expect(renders).toEqual({ a: 1, b: 1, c: 1 });
    act(() => rerender(<List ids={["a", "b", "c"]} selected="b" />));
    expect(getByTestId("a").textContent).toBe("off");
    expect(getByTestId("b").textContent).toBe("on");
    expect(renders).toEqual({ a: 2, b: 2, c: 1 });
    // The same value again (a new object): nobody re-renders.
    act(() => rerender(<List ids={["a", "b", "c"]} selected="b" />));
    expect(renders).toEqual({ a: 2, b: 2, c: 1 });
  });

  it("a row mounted by the render that changed the value reads the new value", () => {
    const { getByTestId, rerender } = render(<List ids={["a"]} selected="a" />);
    act(() => rerender(<List ids={["a", "d"]} selected="d" />));
    expect(getByTestId("d").textContent).toBe("on");
    expect(getByTestId("a").textContent).toBe("off");
  });
});
