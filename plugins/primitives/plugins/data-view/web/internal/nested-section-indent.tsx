import type { ReactNode } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  RAIL_OWED_START_VAR,
  RAIL_START_VAR,
} from "@plugins/primitives/plugins/css/plugins/rail/core";

/** Where a `rail-follow` band's content starts (its start-side inset) — the
 *  same fallback chain the utility pays. */
const RAIL_FOLLOW_START = `var(${RAIL_OWED_START_VAR}, var(${RAIL_START_VAR}, var(--chrome-pad-x)))`;

export interface NestedSectionIndentProps {
  /** The section's nesting depth (`DataViewSection.nesting.depth`); 0 renders
   *  `children` untouched. */
  depth: number;
  /**
   * Draw a hairline per ancestor level, each under the chevron of the header
   * that level belongs to — so a parent's run of child headers and rows hangs
   * off one continuous rule, as a tree's indent guides do. The guides assume
   * the wrapper sits OUTSIDE the box that pays the rail (they start at the
   * rail); a caller nested inside a rail-paying band passes `false`.
   * Default `true`.
   */
  guides?: boolean;
  children: ReactNode;
}

/**
 * The indent of one nested group-by section's header or body: `depth` steps of
 * the tree indent (`--tree-indent`), the same step a tree row nests by, ahead of
 * whatever the band inside pays for the rail. Header and body of a section take
 * the same depth, so a section's rows sit under its own header's label edge
 * and its child sections one step further in.
 *
 * The guides reuse the tree's tokens (`--tree-guide`, `--tree-guide-x`): nested
 * sections ARE a tree, so a theme that softens a tree's guides softens these.
 * Decorative, in the indent padding: they take no click and move no content.
 */
export function NestedSectionIndent({
  depth,
  guides = true,
  children,
}: NestedSectionIndentProps): ReactNode {
  if (depth <= 0) return children;
  return (
    <Stack
      gap="none"
      className="relative"
      data-section-depth={depth}
      style={{ paddingInlineStart: `calc(${depth} * var(--tree-indent))` }}
    >
      {guides && (
        <Placed
          as="span"
          aria-hidden
          decorative
          data-section-guides={depth}
          x={{
            start: RAIL_FOLLOW_START,
            size: `calc(${depth} * var(--tree-indent))`,
          }}
          y="fill"
          style={{
            backgroundImage:
              "linear-gradient(to right, transparent calc(var(--tree-guide-x) - 0.5px), var(--tree-guide) 0, var(--tree-guide) calc(var(--tree-guide-x) + 0.5px), transparent 0)",
            backgroundSize: "var(--tree-indent) 100%",
            backgroundRepeat: "repeat-x",
          }}
        />
      )}
      {children}
    </Stack>
  );
}
