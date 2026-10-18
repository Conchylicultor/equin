import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ReorderAreaContext,
  type ReorderAreaCtxValue,
} from "@plugins/reorder/plugins/area/web";
import { DividerBox } from "../components/divider-box";

afterEach(cleanup);

function area(
  orientation: ReorderAreaCtxValue["orientation"],
): ReorderAreaCtxValue {
  return {
    orientation,
    onHide: () => {},
    onRemoveNode: () => {},
    ItemChrome: null,
  };
}

describe("a divider turns its rule to the area's flow", () => {
  it("draws a flat rule on the rail in a vertical area", () => {
    const { getByRole } = render(
      <ReorderAreaContext.Provider value={area("vertical")}>
        <DividerBox itemKey="d" editMode={false} onRemove={() => {}} />
      </ReorderAreaContext.Provider>,
    );
    const sep = getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBeNull();
    expect(sep.className).toContain("rail-follow");
    expect(sep.firstElementChild!.className).toContain("border-t");
  });

  it("defaults to the flat rule outside any area", () => {
    const { getByRole } = render(
      <DividerBox itemKey="d" editMode={false} onRemove={() => {}} />,
    );
    expect(getByRole("separator").firstElementChild!.className).toContain(
      "border-t",
    );
  });

  it("draws an upright rule sized from the row's control height in a horizontal area", () => {
    const { getByRole } = render(
      <ReorderAreaContext.Provider value={area("horizontal")}>
        <ControlSizeProvider size="md">
          <DividerBox itemKey="d" editMode={false} onRemove={() => {}} />
        </ControlSizeProvider>
      </ReorderAreaContext.Provider>,
    );
    const sep = getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    const rule = sep.firstElementChild as HTMLElement;
    expect(rule.className).toContain("border-l");
    expect(rule.style.height).toContain("--control-height-md");
  });
});
