import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { INLINE_MATH_TOKEN_PATTERN, inlineMathNode } from "../core";

export default {
  portable: true,
  description:
    "Inline math token pattern at the server markdown boundary: protects `\\(<latex>\\)` spans from the marks-aware inline scan.",
  contributions: [
    // The same pattern the web extension deserializes with. Load-bearing here
    // more than for any other token: LaTeX is full of `_` and `*`, so an
    // unprotected expression re-parses as emphasis and comes back mangled.
    //
    // `node` is the SAME spec object `web/components/inline-math-node.tsx`
    // decorates, so a block holding a materialized formula stays server-readable
    // and server-editable.
    Editor.InlineToken({
      pattern: INLINE_MATH_TOKEN_PATTERN,
      // The case masking exists for, as the comment above says. `markdownSpan`
      // is a separate field from `pattern` because most tokens do NOT need it.
      markdownSpan: "protect",
      node: inlineMathNode,
    }),
  ],
} satisfies ServerPluginDefinition;
