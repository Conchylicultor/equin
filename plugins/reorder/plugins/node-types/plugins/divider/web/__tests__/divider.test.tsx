import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ItemBindingProvider } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { DividerBox } from "../components/divider-box";

afterEach(cleanup);

/** An item drawn on either side, so the divider has something to separate. */
function Between({ children }: { children: ReactNode }) {
  return (
    <div>
      <button>before</button>
      {children}
      <button>after</button>
    </div>
  );
}

describe("a divider turns its rule to the area's flow", () => {
  it("draws a flat rule on the rail in a vertical area", () => {
    const { getByRole } = render(
      <Between>
        <DividerBox
          itemKey="d"
          orientation="vertical"
          editMode={false}
          onRemove={() => {}}
        />
      </Between>,
    );
    const sep = getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBeNull();
    expect(sep.className).toContain("rail-follow");
    expect(sep.firstElementChild!.className).toContain("border-t");
  });

  it("draws an upright rule sized from the row's control height in a horizontal area", () => {
    const { getByRole } = render(
      <ControlSizeProvider size="md">
        <Between>
          <DividerBox
            itemKey="d"
            orientation="horizontal"
            editMode={false}
            onRemove={() => {}}
          />
        </Between>
      </ControlSizeProvider>,
    );
    const sep = getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    const rule = sep.firstElementChild as HTMLElement;
    expect(rule.className).toContain("border-l");
    expect(rule.style.height).toContain("--control-height-md");
  });
});

/** An item's reorder wrapper: box-less, drawing whatever its contribution does. */
function Item({ children }: { children?: ReactNode }) {
  return <div style={{ display: "contents" }}>{children}</div>;
}

function Rule() {
  return (
    <DividerBox
      itemKey="d"
      orientation="vertical"
      editMode={false}
      onRemove={() => {}}
    />
  );
}

/** Each separator's shown state, top to bottom. */
function shown(container: HTMLElement): boolean[] {
  return [...container.querySelectorAll("[role=separator]")].map(
    (s) => !(s as HTMLElement).hidden,
  );
}

describe("a divider with nothing to separate hides itself", () => {
  it("shows between two drawn items", () => {
    const { container } = render(
      <div>
        <Item>
          <button>a</button>
        </Item>
        <Rule />
        <Item>
          <button>b</button>
        </Item>
      </div>,
    );
    expect(shown(container)).toEqual([true]);
  });

  it("hides at either end of what is drawn, past items that render nothing", () => {
    const { container } = render(
      <div>
        <Item />
        <Rule />
        <Item>
          <button>a</button>
        </Item>
        <Rule />
        <Item />
      </div>,
    );
    expect(shown(container)).toEqual([false, false]);
  });

  it("keeps one rule around a group whose items all render nothing", () => {
    const { container } = render(
      <div>
        <Item>
          <button>a</button>
        </Item>
        <Rule />
        <Item />
        <Rule />
        <Item>
          <button>b</button>
        </Item>
      </div>,
    );
    expect(shown(container)).toEqual([false, true]);
  });

  it("re-judges when an item starts drawing", async () => {
    function Area({ drawn }: { drawn: boolean }) {
      return (
        <div>
          <Item>
            <button>a</button>
          </Item>
          <Rule />
          <Item>{drawn ? <button>b</button> : null}</Item>
        </div>
      );
    }
    const { container, rerender } = render(<Area drawn={false} />);
    expect(shown(container)).toEqual([false]);
    rerender(<Area drawn />);
    // The MutationObserver delivers on a microtask.
    await act(async () => {});
    expect(shown(container)).toEqual([true]);
  });

  it("always shows in edit mode (a draggable placeholder)", () => {
    const { container } = render(
      <ItemBindingProvider>
        <div>
          <DividerBox
            itemKey="d"
            orientation="vertical"
            editMode
            onRemove={() => {}}
          />
        </div>
      </ItemBindingProvider>,
    );
    expect(container.querySelector("[hidden]")).toBeNull();
  });
});
