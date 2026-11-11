import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeferredSortableItem } from "@plugins/primitives/plugins/sortable-list/plugins/deferred-item/web";
import { DeferredSortableList } from "../internal/deferred-sortable";

function List({ enabled }: { enabled: boolean }) {
  const ids = ["a", "b"];
  return (
    <DeferredSortableList enabled={enabled} items={ids} onMove={() => {}}>
      {ids.map((id) => (
        <DeferredSortableItem key={id} id={id}>
          {() => <i>{id}</i>}
        </DeferredSortableItem>
      ))}
    </DeferredSortableList>
  );
}

// A static render to HTML (react-dom/server) reads each registrar's published
// node as the binding store holds it — none, since no item mounted a DOM node:
// it must not throw, and the items render as plain boxes.
describe("DeferredSortableList under a server render", () => {
  it("renders the items with the drag host mounted", () => {
    const html = renderToStaticMarkup(<List enabled />);
    expect(html).toContain("<div><i>a</i></div><div><i>b</i></div>");
  });

  it("renders the items with no drag host", () => {
    expect(renderToStaticMarkup(<List enabled={false} />)).toBe(
      "<div><i>a</i></div><div><i>b</i></div>",
    );
  });
});
