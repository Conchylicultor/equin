import { useMemo, type ComponentType, type ReactNode } from "react";
import { defineSlot, type Slot } from "@plugins/framework/plugins/web-sdk/core";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";

/**
 * The markdown enhancer pipeline. `stage` is a processing position, not a place
 * on screen: enhancers nest lowest stage outermost, so a lower stage's transform
 * is stacked first and sees the text before a higher one claims it (active-data
 * chips at 0 before file-links at 10). A pipeline, not painted rows — so it is
 * not a reorder layout, which a user could rearrange into a broken render.
 */
export const MarkdownEnhancerSlot: Slot<{
  id: string;
  /** Processing stage: lower runs first (outermost), higher sees what it left. */
  stage: number;
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
    () => [...enhancers].sort((a, b) => a.stage - b.stage),
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
