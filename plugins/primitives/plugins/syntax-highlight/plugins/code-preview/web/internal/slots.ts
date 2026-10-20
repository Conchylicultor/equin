import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";

/**
 * One language a code fence can be previewed in: its source drawn as what it
 * describes (a `mermaid` fence as its diagram). The component owns its own error
 * state (`CodePreviewError`) — a source that does not parse is shown, not hidden.
 */
export interface CodePreviewRendererContribution {
  /** The canonical fence language (` ```mermaid `), lowercase. */
  lang: string;
  /** Other fence spellings of the same language, lowercase. */
  aliases?: readonly string[];
  /** The language's name in pickers ("Mermaid"). */
  label: string;
  Component: ComponentType<{ source: string }>;
}

export const CodePreview = {
  Renderer: defineSlot<CodePreviewRendererContribution>({
    docLabel: (p) => p.lang,
  }),
};
