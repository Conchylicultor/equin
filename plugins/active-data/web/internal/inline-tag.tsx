import type { ReactNode } from "react";
import { z } from "zod";
import { useMarkdownTransform } from "@plugins/primitives/plugins/markdown/web";
import { ActiveData } from "../slots";

const AttrsSchema = z.record(z.string(), z.string());

/**
 * The markdown element {@link remarkInlineTags} made from an inline tag: looks
 * the tag's `inline` renderer up in the registry and hands it the rendered
 * markdown between the tags — with the enhancers' transforms run on it, since
 * they leave a custom element opaque (so a `task-…` inside still chips). Reads
 * the registry itself, never a prop — the markdown renderer memoizes its whole
 * element (see code-chain).
 */
export function ActiveDataInlineTag({
  children,
  "data-tag": tag,
  "data-content": content,
  "data-attrs": attrs,
}: {
  children?: ReactNode;
  "data-tag": string;
  "data-content": string;
  "data-attrs": string;
}) {
  const contributions = ActiveData.Tag.useContributions();
  const transform = useMarkdownTransform();
  const contrib = contributions.find(
    (c) => c.display === "block" && c.tag === tag && c.inline,
  );
  // The remark pass only pairs tags that had an inline renderer when the
  // enhancer built it, so this is the registry changing under a rendered tree.
  if (!contrib || contrib.display !== "block" || !contrib.inline) {
    throw new Error(`No inline active-data renderer for <${tag}>`);
  }
  // `inline` is a plain ComponentType (only `component` is sealed), rendered
  // as a member expression so no component is minted during render.
  const found = { Inline: contrib.inline };
  return (
    <found.Inline
      content={content}
      attrs={AttrsSchema.parse(JSON.parse(attrs))}
    >
      {transform(children)}
    </found.Inline>
  );
}
