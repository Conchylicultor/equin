import { defineVariantRegion } from "@plugins/ui/plugins/variant-region/core";
import type { TreeDisclosureProps } from "@plugins/primitives/plugins/tree/core";

/**
 * The tree-disclosure region: swaps how an icon-bearing tree row presents its
 * identity icon and its expand/collapse affordance.
 *
 * Per-app scope: an app whose design names a disclosure (Pages and the file
 * explorer: merged) commits it under `config/ui/tree-disclosure/@app/<id>/`;
 * every other app follows the base pick.
 *
 * Defaults to `column` — a faint chevron only on rows with children, every
 * icon on one rail — until the user picks another in the theme customizer.
 * The density defaults are built for it (`treeIndent` = chevron box + row gap,
 * `treeGuideX` = half the chevron box).
 */
export const treeDisclosure = defineVariantRegion<TreeDisclosureProps>({
  id: "tree-disclosure",
  label: "Tree disclosure",
  defaultVariant: "column",
  scope: "app",
});
