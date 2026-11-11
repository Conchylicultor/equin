import { describe, expect, it } from "bun:test";
import { createEditor } from "lexical";
import { renderToStaticMarkup } from "react-dom/server";
import { useCaretOwner } from "./arbiter";

// A static render to HTML (react-dom/server, never hydrated) reads the
// arbiter as it stands: no candidate published, so no hook owns the caret.
describe("useCaretOwner under a server render", () => {
  it("reads the arbiter's current owner", () => {
    const editor = createEditor();
    function Probe() {
      return <i>{String(useCaretOwner(editor, "slash").isCaretOwner)}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
