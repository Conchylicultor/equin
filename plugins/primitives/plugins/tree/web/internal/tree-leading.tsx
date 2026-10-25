import type { ReactNode } from "react";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { TreeDisclosureProps } from "../../core";
import { Tree } from "../slots";
import {
  TREE_CHEVRON_CLASS,
  TreeDisclosureToggle,
} from "./tree-disclosure-toggle";
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
 * The chevron box (`--tree-chevron-w` wide): a faint chevron on a row with
 * children, else the box's width reserved for alignment — a leaf renders no
 * expander (a chevron exists exactly when the row has children, or a lazy row
 * may have some); dropping onto a leaf still nests under it.
 */
function ChevronCell({
  hasChildren,
  isOpen,
  onToggle,
}: Pick<TreeDisclosureProps, "hasChildren" | "isOpen" | "onToggle">) {
  return hasChildren ? (
    <TreeDisclosureToggle
      isOpen={isOpen}
      onToggle={onToggle}
      className={TREE_CHEVRON_CLASS}
    />
  ) : (
    <span className={`w-tree-chevron h-5 ${rigidClass()}`} aria-hidden />
  );
}

/**
 * The column disclosure (Finder / VS Code style) — the tree-disclosure
 * region's default. The tree owns it because it is also the fallback when no
 * `Tree.Disclosure` is contributed, so rows render the same whether or not that
 * plugin is loaded; the region's `column` variant contributes this component.
 *
 * Two cells of the row (a fragment, spaced by the row's `gap-tree-row`): the
 * chevron box — a faint chevron on a row with children, empty space on a leaf
 * — then the icon. The density defaults are built for it: the indent is one
 * chevron box plus the gap (a child's chevron under its parent's icon), a guide
 * sits at half the chevron box (under its parent's chevron).
 */
export function TreeColumnDisclosure({
  icon,
  hasChildren,
  isOpen,
  onToggle,
}: TreeDisclosureProps) {
  return (
    <>
      <ChevronCell
        hasChildren={hasChildren}
        isOpen={isOpen}
        onToggle={onToggle}
      />
      <Center as="span" axis="both" className={`size-5 ${rigidClass()}`}>
        {icon}
      </Center>
    </>
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
  // default column disclosure.
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
          <TreeColumnDisclosure {...disclosureProps} />
        )
      ) : (
        // An icon-less row: the chevron box alone, the same cell the column
        // disclosure draws ahead of an icon.
        <ChevronCell
          hasChildren={hasChildren}
          isOpen={isOpen}
          onToggle={onToggle}
        />
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
