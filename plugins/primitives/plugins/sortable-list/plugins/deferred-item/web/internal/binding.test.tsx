import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeferredSortableItem, ItemBindingProvider } from "./binding";

// A static render to HTML (react-dom/server, no DOM) reads the binding store
// as it stands: no drag host is bound there, so the item is a plain box.
describe("DeferredSortableItem under a server render", () => {
  it("renders a plain box, not dragging", () => {
    const html = renderToStaticMarkup(
      <ItemBindingProvider>
        <DeferredSortableItem
          id="a"
          className={(s) => (s.isDragging ? "dragging" : "rest")}
        >
          {(s) => <i>{String(s.isDragging)}</i>}
        </DeferredSortableItem>
      </ItemBindingProvider>,
    );
    expect(html).toBe('<div class="rest"><i>false</i></div>');
  });
});
