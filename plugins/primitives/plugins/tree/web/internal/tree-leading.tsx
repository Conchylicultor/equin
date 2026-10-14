import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { CollapsibleChevron } from "@plugins/primitives/plugins/collapsible/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { TreeDisclosureProps } from "../../core";
import { Tree } from "../slots";
import { TreeDisclosureToggle } from "./tree-disclosure-toggle";
import { TreeGuides } from "./tree-guides";

export type TreeLeadingProps = {
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
  /** Chevron click. Stops propagation internally so it never triggers the row's select. */
  onToggle?: () => void;
  /** Row icon merged into the chevron slot (see `TreeRowChromeProps.icon`). */
  icon?: ReactNode;
  /** Control between the chevron block and the label (the multi-select checkbox). */
  leading?: ReactNode;
  /** Draw the indent guides. Default false. */
  guides?: boolean;
};

/**
 * The current (and default) icon-bearing disclosure, extracted verbatim from
 * the row below. Used when no `Tree.Disclosure` is contributed, so rows render
 * identically even if the tree-disclosure plugin is not loaded. The `merged`
 * variant of tree-disclosure mirrors this byte-for-byte.
 *
 * Notion-style merged slot: icon at rest, chevron on row hover, both sharing
 * one size-5 box — only on a row with children; a leaf keeps its icon. The
 * icon is purely visual (the row click navigates); the overlaid chevron button
 * owns the toggle.
 */
function DefaultMergedDisclosure({
  icon,
  hasChildren,
  isOpen,
  onToggle,
}: TreeDisclosureProps) {
  return (
    <Center as="span" axis="both" className="relative size-5">
      <Center
        as="span"
        axis="both"
        className={cn(
          hasChildren &&
            "group-hover/tree-row:opacity-0 group-hover/tree-row:pointer-events-none",
        )}
      >
        {icon}
      </Center>
      {hasChildren && (
        <TreeDisclosureToggle
          isOpen={isOpen}
          onToggle={onToggle}
          className={cn(
            // The chevron button overlays the icon slot full-bleed (icon at
            // rest, chevron on hover). It is the layer itself, so it takes the
            // class rather than a wrapping <Layer>.
            layerClasses(),
            "opacity-0 pointer-events-none group-hover/tree-row:opacity-100 group-hover/tree-row:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
          )}
        />
      )}
    </Center>
  );
}

/**
 * The tree-specific head of a row, ahead of its label: the indent guides, the
 * disclosure (the contributed `Tree.Disclosure` variant when the row has an
 * icon, else a plain chevron, else the chevron's width for alignment) and the
 * leading control. A fragment, so it composes into whatever box is the row's
 * first cell — `TreeRowChrome`'s flex row, or a table's leading cell. That box
 * must be `relative` (the guides are placed in it), carry the indent
 * (`treeRowIndentStyle`), and sit inside the named `group/tree-row`, which the
 * chevron's hover reveal reads.
 */
export function TreeLeading({
  depth,
  hasChildren,
  isOpen,
  onToggle,
  icon,
  leading,
  guides = false,
}: TreeLeadingProps) {
  // A UI plugin can contribute the icon-bearing leading disclosure (merged /
  // dimmed-leaf / column). Exactly one is expected — its Region internally
  // dispatches to the active variant. With none, fall back to the inline
  // default merged disclosure.
  const disclosures = Tree.Disclosure.useContributions();
  const disclosure = disclosures[0];
  const disclosureProps: TreeDisclosureProps = {
    icon,
    hasChildren,
    isOpen,
    onToggle,
  };
  return (
    <>
      {guides && <TreeGuides depth={depth} />}
      {icon != null ? (
        // useContributions() seals the `component` field, so the disclosure
        // can't be rendered as <Disclosure/>; route it through renderIsolated
        // (which unseals and applies the error-boundary middleware).
        disclosure ? (
          renderIsolated(
            Tree.Disclosure,
            disclosure as unknown as Contribution,
            disclosureProps,
          )
        ) : (
          <DefaultMergedDisclosure {...disclosureProps} />
        )
      ) : hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={isOpen ? "Collapse" : "Expand"}
          className={cn(
            "size-5 rounded-md",
            "hover:bg-background/60",
            "opacity-40 group-hover/tree-row:opacity-100",
          )}
        >
          <Center axis="both" className="size-full">
            <CollapsibleChevron open={isOpen} className="size-4" />
          </Center>
        </button>
      ) : (
        // A leaf: reserve the chevron's width for alignment, but render no
        // expander — a chevron exists exactly when the row has children (or a
        // lazy row may have some). Dropping onto a leaf still nests under it.
        <span className="size-5" aria-hidden />
      )}
      {leading != null && (
        <Center
          as="span"
          axis="both"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {leading}
        </Center>
      )}
    </>
  );
}
