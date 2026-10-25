import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { prototypeBlock } from "../core";
import { PrototypeBlock } from "./components/prototype-block";

export default {
  description:
    'Prototype block type: links a prototype (proto-…) into a page as its rendered preview, played live in place on click, its canvas opened beside the page. Inserted by /prototype (a picker over every prototype), or written by an agent as <prototype id="proto-…"/>.',
  contributions: [
    Editor.Block({
      id: prototypeBlock.type,
      match: prototypeBlock.type,
      block: prototypeBlock,
      component: PrototypeBlock,
      caret: "editor",
    }),
  ],
} satisfies PluginDefinition;
