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
// Every run of a row's function, bailed-out ones included (a render React
// throws away commits no effect, so `renders` cannot see it).
const calls: Record<string, number> = {};

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

const LabelledRow = memo(function LabelledRow({
  id,
  label,
  state,
}: {
  id: string;
  label: string;
  state: LatestStore<State>;
}): ReactNode {
  useLayoutEffect(() => {
    renders[id] = (renders[id] ?? 0) + 1;
  });
  // eslint-disable-next-line react-hooks/immutability -- counts every run of the function, bailed-out ones included, which no effect can see
  calls[id] = (calls[id] ?? 0) + 1;
  const selected = useLatestSelector(state, (s) => s.selected === id);
  return <span data-testid={id}>{`${label} ${selected ? "on" : "off"}`}</span>;
});

function Labelled({
  ids,
  label,
  selected,
}: {
  ids: string[];
  label: string;
  selected: string;
}) {
  const state = useLatestStore<State>({ selected });
  return (
    <>
      {ids.map((id) => (
        <LabelledRow key={id} id={id} label={label} state={state} />
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

  it("a row re-rendered by the render that changed the value renders once, with the new answer", () => {
    for (const k of Object.keys(renders)) delete renders[k];
    for (const k of Object.keys(calls)) delete calls[k];
    const { getByTestId, rerender } = render(
      <Labelled ids={["a", "b"]} label="x" selected="a" />,
    );
    expect(renders).toEqual({ a: 1, b: 1 });
    // Every row's own props change (the label) in the same render as the
    // selection: each renders once, and never again to be corrected.
    act(() => rerender(<Labelled ids={["a", "b"]} label="y" selected="b" />));
    expect(getByTestId("a").textContent).toBe("y off");
    expect(getByTestId("b").textContent).toBe("y on");
    expect(renders).toEqual({ a: 2, b: 2 });
    // Not even a bailed-out run more: `useSyncExternalStore` would force one
    // (it learns a reader's answer in a passive effect, after the layout
    // effect that publishes), in an extra synchronous commit.
    expect(calls).toEqual({ a: 2, b: 2 });
  });

  it("a row mounted by the render that changed the value reads the new value", () => {
    const { getByTestId, rerender } = render(<List ids={["a"]} selected="a" />);
    act(() => rerender(<List ids={["a", "d"]} selected="d" />));
    expect(getByTestId("d").textContent).toBe("on");
    expect(getByTestId("a").textContent).toBe("off");
  });
});
