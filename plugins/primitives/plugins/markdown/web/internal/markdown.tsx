import { useMemo, type ComponentType, type ReactNode } from "react";
import { defineSlot, type Slot } from "@plugins/framework/plugins/web-sdk/core";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";

export const MarkdownEnhancerSlot: Slot<{
  id: string;
  order: number;
  Component: ComponentType<{ children: ReactNode }>;
}> = defineSlot();

// The heavy renderer (react-markdown + remark-gfm + the syntax-highlighter base
// map) is code-split into its own chunk so it never rides the eager plugin-boot
// wave — it loads on the first markdown render of the session. `fallback: null`
// because markdown is inline in transcripts: a spinner would be jarring, so it
// just pops in once the chunk resolves (only the first render suspends).
const MarkdownRenderer = lazyComponent<{ children: string; inline?: boolean }>(
  () =>
    import("./markdown-renderer").then((m) => ({
      default: m.MarkdownRenderer,
    })),
  { fallback: null },
);

export function Markdown({
  children,
  className,
  inline,
}: {
  children: string;
  className?: string;
  /**
   * Phrasing content only: paragraphs are unwrapped into their words, so the
   * text sits in a line beside other inline content (a table cell, a checklist
   * row) instead of opening a block with its own margins.
   */
  inline?: boolean;
}) {
  const enhancers = MarkdownEnhancerSlot.useContributions();

  const sorted = useMemo(
    () => [...enhancers].sort((a, b) => a.order - b.order),
    [enhancers],
  );

  let content: ReactNode = (
    <MarkdownRenderer inline={inline}>{children}</MarkdownRenderer>
  );

  for (let i = sorted.length - 1; i >= 0; i--) {
    const { Component } = sorted[i]!;
    content = <Component>{content}</Component>;
  }

  return className ? (
    <div className={className}>{content}</div>
  ) : (
    <>{content}</>
  );
}
