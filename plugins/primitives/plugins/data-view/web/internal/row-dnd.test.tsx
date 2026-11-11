import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  useIsBackgroundDropTarget,
  useRowDropState,
  type RowDnd,
} from "./row-dnd";

type Over = ReturnType<RowDnd<unknown>["store"]["get"]>;

/** A drag stopped where `over` says (the store a view's useRowDnd holds). */
function dndAt(over: Over): RowDnd<unknown> {
  return {
    rowProps: () => ({}),
    backgroundProps: () => undefined,
    placement: "into",
    store: {
      get: () => over,
      set: () => undefined,
      subscribe: () => () => undefined,
    },
    isWithin: (key, ancestor) => key === "child" && ancestor === "folder",
  };
}

function Probe({
  dnd,
  rowKey,
}: {
  dnd: RowDnd<unknown> | null;
  rowKey: string;
}) {
  const state = useRowDropState(dnd, rowKey);
  const background = useIsBackgroundDropTarget(dnd, null);
  return <i>{`${String(state)},${String(background)}`}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the drop-over
// store as it stands: it must not throw.
describe("drop state under a server render", () => {
  it("reads no drop without a drag", () => {
    expect(renderToStaticMarkup(<Probe dnd={null} rowKey="a" />)).toBe(
      "<i>null,false</i>",
    );
  });

  it("reads the row a drag is over, and the folder it drops into", () => {
    const into = dndAt({ kind: "row", key: "folder", edge: "into" });
    expect(renderToStaticMarkup(<Probe dnd={into} rowKey="folder" />)).toBe(
      "<i>into,false</i>",
    );
    expect(renderToStaticMarkup(<Probe dnd={into} rowKey="child" />)).toBe(
      "<i>inside,false</i>",
    );
  });

  it("reads a drag over a section's empty space", () => {
    const bg = dndAt({ kind: "background", group: null });
    expect(renderToStaticMarkup(<Probe dnd={bg} rowKey="a" />)).toBe(
      "<i>null,true</i>",
    );
  });
});
