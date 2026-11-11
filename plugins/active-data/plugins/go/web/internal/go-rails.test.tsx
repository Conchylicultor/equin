import { describe, expect, it } from "bun:test";
import { createEditor } from "lexical";
import { renderToStaticMarkup } from "react-dom/server";
import { setRails, useRail } from "./go-rails";

// A static render to HTML (react-dom/server, never hydrated) reads the rail
// store as it stands.
describe("useRail under a server render", () => {
  function Probe({ editor }: { editor: ReturnType<typeof createEditor> }) {
    const rail = useRail(editor, "close-1");
    return (
      <i>
        {rail === undefined
          ? "none"
          : `${rail.left},${rail.top},${rail.height}`}
      </i>
    );
  }

  it("reads no rail before one is measured", () => {
    expect(renderToStaticMarkup(<Probe editor={createEditor()} />)).toBe(
      "<i>none</i>",
    );
  });

  it("reads the rail the store holds", () => {
    const editor = createEditor();
    setRails(editor, new Map([["close-1", { left: 1, top: 2, height: 3 }]]));
    expect(renderToStaticMarkup(<Probe editor={editor} />)).toBe(
      "<i>1,2,3</i>",
    );
  });
});
