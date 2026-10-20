import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { CodePreview } from "@plugins/primitives/plugins/syntax-highlight/plugins/code-preview/web";
import { MermaidPreview } from "./internal/mermaid-preview";

export default {
  description:
    "Mermaid as a code preview: a mermaid fence (in markdown, or a page code block set to mermaid) drawn as its diagram. Sequence diagrams and flowcharts are drawn natively from the parsed source (core: parseMermaid) — participant cards, coloured numbered steps, framed blocks; dagre-laid-out node cards with label pills and subgraph frames — in the theme's own type and colours at the text's size, scrolling rather than shrinking. Every other type (and any source the parser does not read) is drawn by Mermaid itself, lazy-loaded, with its parse error shown in place of (or under the last good) diagram.",
  contributions: [
    CodePreview.Renderer({
      lang: "mermaid",
      aliases: ["mmd"],
      label: "Mermaid",
      Component: MermaidPreview,
    }),
  ],
} satisfies PluginDefinition;
