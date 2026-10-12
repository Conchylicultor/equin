import { useMemo, type ReactNode } from "react";
import { linkifyChildren } from "@plugins/primitives/plugins/file-links/web";
import {
  InlineTextWalkerContext,
  useInlineTextWalker,
  type InlineTextWalker,
} from "@plugins/primitives/plugins/inline-text/web";
import { useFileTarget } from "./use-file-target";

// Registers the file-links walker into the inline-text pipeline (order 10 —
// after active-data, so it recurses the Fragment-wrapped output and linkifies
// the remaining raw file paths while leaving chips opaque). Shares the exact
// file-target resolution used by the markdown FileLinksEnhancer. Outside any
// worktree context the walker is a no-op (file paths stay plain text).
export function FileLinksInlineWalker({ children }: { children: ReactNode }) {
  const fileTarget = useFileTarget();
  const walker = useMemo<InlineTextWalker | null>(
    () =>
      fileTarget
        ? { transform: (c: ReactNode) => linkifyChildren(c, fileTarget) }
        : null,
    [fileTarget],
  );
  const value = useInlineTextWalker(walker);
  return (
    <InlineTextWalkerContext.Provider value={value}>
      {children}
    </InlineTextWalkerContext.Provider>
  );
}
