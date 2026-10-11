import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MarkdownEnhancerSlot } from "@plugins/primitives/plugins/markdown/web";
import { InlineTextWalkerSlot } from "@plugins/primitives/plugins/inline-text/web";
// Side-effect: the inline-chip union (primitives/text-editor/inline-chip), as a
// lazy source of the PAGE editor's block-text extensions — so an id written in a
// page block is a chip there too.
import "./internal/register-block-text-source";

export { ActiveData, codeTag } from "./slots";
export type {
  ActiveDataContribution,
  ActiveDataBlockContribution,
  ActiveDataCodeContribution,
} from "./slots";
export { claimPending, declined, claimed } from "./claim";
export type { CodeClaim, CodeResolver } from "./claim";
export {
  maskCode,
  useActiveDataSegments,
} from "./internal/segment-active-data";
export type { ActiveDataSegment } from "./internal/segment-active-data";
export { useActiveDataLinkify } from "./internal/linkify-active-data";
export {
  ActiveDataIdentityProvider,
  useActiveDataIdentity,
} from "./internal/identity-context";
export type { ActiveDataIdentity } from "./internal/identity-context";
export { useActiveDataBinding } from "./internal/use-active-data-binding";
export type { ActiveDataBindingHandle } from "./internal/use-active-data-binding";

import { ActiveData as ActiveDataSlots } from "./slots";
import { ActiveDataMarkdownEnhancer } from "./internal/markdown-enhancer";
import { ActiveDataInlineWalker } from "./internal/inline-walker";

export default {
  collapsed: true,
  description:
    "Meta plugin for inline interactive widgets agents render via XML-like tags in assistant text. Sub-plugins contribute block (tag) and code (claimed code-span) renderers, and declare inline chips through primitives/text-editor/inline-chip; hosts use useActiveDataSegments() + useActiveDataLinkify().",
  contributions: [
    MarkdownEnhancerSlot({
      id: "active-data",
      order: 0,
      Component: ActiveDataMarkdownEnhancer,
    }),
    // Plain-text (non-markdown) counterpart of the markdown enhancer: the same
    // inline-pattern walker, registered into the inline-text pipeline before
    // file-links (order 0). Keeps user-text/task-description chips in sync with
    // the markdown surfaces from one registry.
    InlineTextWalkerSlot({
      id: "active-data",
      order: 0,
      Component: ActiveDataInlineWalker,
    }),
  ],
  slots: ActiveDataSlots,
} satisfies PluginDefinition;
