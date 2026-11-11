import { describe, expect, it } from "bun:test";
import { createEditor } from "lexical";
import { renderToStaticMarkup } from "react-dom/server";
import { useTokenSelected } from "./token-frame";

// A static render to HTML (react-dom/server, never hydrated) reads the
// editor's in-memory state: a fresh editor has no selection, so no token is
// selected.
describe("useTokenSelected under a server render", () => {
  it("reads the editor state's selection", () => {
    const editor = createEditor();
    function Probe() {
      return <i>{String(useTokenSelected(editor, "1"))}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
