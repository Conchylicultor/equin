import { describe, it, expect } from "vitest";
import { createEditor, $getRoot, $createParagraphNode } from "lexical";
import { ImageNode, $createImageNode } from "../internal/image-node";
import { fileWebNode, $createFileNode } from "../internal/file-node";

// A prompt editor is a PLAIN-TEXT Lexical editor: its copy writes only
// `text/plain`, the selection's text content. An attachment whose text content
// is empty is lost on copy (and a paste over the selection then deletes it), so
// both attachment families emit their markdown token — the text the paste plugin
// rebuilds the node from.
describe("attachment node copy", () => {
  it("emits each attachment's markdown token as text content", () => {
    const editor = createEditor({
      nodes: [ImageNode, fileWebNode.Node],
      onError: (e) => {
        throw e;
      },
    });
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append(
          $createImageNode({ attachmentId: "img-1", alt: "shot.png" }),
          $createFileNode({ attachmentId: "file-1", filename: "notes.pdf" }),
        );
        $getRoot().clear().append(p);
      },
      { discrete: true },
    );
    let text = "";
    editor.getEditorState().read(() => {
      text = $getRoot().getTextContent();
    });
    expect(text).toBe(
      "![shot.png](/api/attachments/img-1)[notes.pdf](/api/attachments/file-1)",
    );
  });
});
