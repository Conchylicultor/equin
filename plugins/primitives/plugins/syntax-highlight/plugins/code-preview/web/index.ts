import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { CodePreview } from "./internal/slots";

export { CodePreview } from "./internal/slots";
export type { CodePreviewRendererContribution } from "./internal/slots";
export {
  useCodePreviewLangs,
  useCodePreviewRenderer,
} from "./internal/use-code-preview";
export { CodePreviewError } from "./internal/code-preview-error";

export default {
  description:
    "Registry of code previews keyed by fence language: a CodePreview.Renderer contribution ({ lang, aliases, label, Component }) draws a language's source as what it describes — a mermaid fence as its diagram. Consumers (markdown fences, the page code block) read it only through useCodePreviewRenderer / useCodePreviewLangs, so a new language needs no consumer change; CodePreviewError is the shared failure chrome.",
  contributions: [],
  slots: CodePreview,
} satisfies PluginDefinition;
