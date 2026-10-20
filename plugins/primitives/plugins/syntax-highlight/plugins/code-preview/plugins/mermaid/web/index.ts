import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { CodePreview } from "@plugins/primitives/plugins/syntax-highlight/plugins/code-preview/web";
import { MermaidPreview } from "./internal/mermaid-preview";

export default {
  description:
    "Mermaid as a code preview: a mermaid fence (in markdown, or a page code block set to mermaid) drawn as its diagram — lazy-loaded, themed from the surrounding theme tokens, with the parse error shown in place of (or under the last good) diagram.",
  contributions: [
    CodePreview.Renderer({
      lang: "mermaid",
      aliases: ["mmd"],
      label: "Mermaid",
      Component: MermaidPreview,
    }),
  ],
} satisfies PluginDefinition;
