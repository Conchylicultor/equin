import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createHoverStore,
  useHoverPoint,
  type HoverStore,
} from "./hover-store";

function Probe({ store }: { store: HoverStore }) {
  const point = useHoverPoint(store);
  return (
    <i>
      {point === null
        ? "none"
        : `${String(point.beat)}@${String(point.fraction)}`}
    </i>
  );
}

// A static render to HTML (react-dom/server, no DOM) reads the hover store as
// it stands: it must not throw.
describe("useHoverPoint under a server render", () => {
  it("reads nothing hovered", () => {
    expect(renderToStaticMarkup(<Probe store={createHoverStore()} />)).toBe(
      "<i>none</i>",
    );
  });

  it("reads the point the store holds", () => {
    const store = createHoverStore();
    store.set({ beat: 4, fraction: 0.5 });
    expect(renderToStaticMarkup(<Probe store={store} />)).toBe("<i>4@0.5</i>");
  });
});
