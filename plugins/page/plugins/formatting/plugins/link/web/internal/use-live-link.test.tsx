import { describe, expect, it } from "bun:test";
import { $createLinkNode, LinkNode } from "@lexical/link";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type NodeKey,
} from "lexical";
import { renderToStaticMarkup } from "react-dom/server";
import { useLiveLink } from "./use-live-link";

// A static render to HTML (react-dom/server, never hydrated) reads the
// editor's in-memory state: the link as the editor holds it now.
describe("useLiveLink under a server render", () => {
  function Probe({
    editor,
    linkKey,
  }: {
    editor: ReturnType<typeof createEditor>;
    linkKey: NodeKey | null;
  }) {
    const link = useLiveLink(editor, linkKey);
    return <i>{link === null ? "none" : `${link.url} ${link.text}`}</i>;
  }

  it("reads the link's href and text", () => {
    const editor = createEditor({
      nodes: [LinkNode],
      onError: (e) => {
        throw e;
      },
    });
    let key: NodeKey | null = null;
    editor.update(
      () => {
        const link = $createLinkNode("https://equin.dev");
        link.append($createTextNode("equin"));
        $getRoot().append($createParagraphNode().append(link));
        key = link.getKey();
      },
      { discrete: true },
    );
    expect(renderToStaticMarkup(<Probe editor={editor} linkKey={key} />)).toBe(
      "<i>https://equin.dev equin</i>",
    );
  });

  it("reads none without a link", () => {
    expect(
      renderToStaticMarkup(<Probe editor={createEditor()} linkKey={null} />),
    ).toBe("<i>none</i>");
  });
});
