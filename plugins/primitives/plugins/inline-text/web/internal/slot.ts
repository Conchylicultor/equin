import { defineSlot, type Slot } from "@plugins/framework/plugins/web-sdk/core";
import type { ComponentType, ReactNode } from "react";

// Registry of inline-text walkers. Each contributor wraps `children` and pushes
// a `(ReactNode) => ReactNode` transform onto the InlineTextWalkerContext (via
// useInlineTextWalker). `<InlineText>` mounts these Components sorted by `stage`
// (lower runs first) and seeds the innermost with the raw string. Mirrors
// MarkdownEnhancerSlot — the same staged-walker model, but for plain text.
// `stage` is a processing position (which walker sees the raw text first), not
// a place on screen, so it is not a reorder layout.
export const InlineTextWalkerSlot: Slot<{
  id: string;
  /** Processing stage: lower runs first and sees the raw text. */
  stage: number;
  Component: ComponentType<{ children: ReactNode }>;
}> = defineSlot();
