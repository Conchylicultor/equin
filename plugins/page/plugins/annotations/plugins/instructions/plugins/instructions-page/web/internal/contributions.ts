import type { PageData } from "@plugins/page/plugins/editor/core";
import type {
  InsertAction,
  InsertActionRun,
} from "@plugins/page/plugins/editor/web";
import {
  useOpenMadePage,
  type PageReferenceDecorationContribution,
} from "@plugins/page/plugins/page-reference/web";
import { instructionsBlock } from "@plugins/page/plugins/annotations/plugins/instructions/core";
import { InstructionsPageChip } from "../components/instructions-page-chip";
import { turnIntoInstructionsPage } from "./turn-into-instructions-page";
import { symbol } from "@plugins/ui/plugins/icons/core";

const menuBookIcon = symbol("menu-book");

/** An instructions page is a `page` row whose data says so. */
function isInstructionsPage(page: PageData): boolean {
  return page.instructions === true;
}

/**
 * How a reference paints an instructions page: the inline `<instructions>`
 * card's own `primary` wash, so the card and the page read as one thing, and a
 * `Global` chip when the page reaches every conversation.
 *
 * The wash co-publishes itself as `--scrim`, like the agent page's, so an action
 * cluster pinned over the tinted row dissolves into the tint, not into a hole.
 */
export const instructionsPageDecoration: PageReferenceDecorationContribution = {
  applies: isInstructionsPage,
  tint: "bg-primary/10 [--scrim:color-mix(in_srgb,var(--primary)_10%,var(--chrome-mask))]",
  component: InstructionsPageChip,
};

/** Turn the line into the page, then open it (`useOpenMadePage`). */
function useInstructionsPageInsertRun(): InsertActionRun {
  const openMadePage = useOpenMadePage();
  return ({ blockId, text }) => {
    openMadePage(turnIntoInstructionsPage(blockId, text), blockId);
  };
}

/**
 * `/instructions page`: an instructions page made in place of the caret's line,
 * listed right after the inline instructions card, its sibling in the menu.
 */
export const instructionsPageInsertAction: InsertAction = {
  id: "instructions-page",
  label: "Instructions page",
  icon: menuBookIcon,
  aliases: ["instructions page", "rules page", "instructions-page"],
  after: instructionsBlock.type,
  useRun: useInstructionsPageInsertRun,
};
