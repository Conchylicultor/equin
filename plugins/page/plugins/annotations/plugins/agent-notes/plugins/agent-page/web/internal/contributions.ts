import type { PageData } from "@plugins/page/plugins/editor/core";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type {
  InsertAction,
  InsertActionRun,
} from "@plugins/page/plugins/editor/web";
import {
  useOpenMadePage,
  type PageReferenceDecorationContribution,
} from "@plugins/page/plugins/page-reference/web";
import { agentNotesBlock } from "@plugins/page/plugins/annotations/plugins/agent-notes/core";
import { AgentPageCreatorChip } from "../components/agent-page-creator-chip";
import { turnIntoAgentPage } from "./turn-into-agent-page";
import { agentPageTitle } from "./title";
import { symbol } from "@plugins/ui/plugins/icons/core";

const autoAwesomeIcon = symbol("auto-awesome");

/** An agent-authored page is a `page` row whose data says so. */
function isAgentAuthoredPage(page: PageData): boolean {
  return page.author === "agent";
}

/**
 * How a reference paints an agent-authored page: the agent-notes card's own
 * wash (`agent-notes-frame.tsx`), so "an agent wrote this" reads the same in a
 * card and in a page row, and the chip naming the conversation that created it.
 *
 * The wash co-publishes itself as `--scrim` — its composite over the ambient
 * mask, the way `Row`'s translucent hover does — so an action cluster pinned
 * over a tinted row dissolves what it covers into blue, not into a hole.
 */
export const agentPageDecoration: PageReferenceDecorationContribution = {
  applies: isAgentAuthoredPage,
  tint: "bg-info/10 [--scrim:color-mix(in_srgb,var(--info)_10%,var(--chrome-mask))]",
  component: AgentPageCreatorChip,
};

/** Turn the line into the page, then open it (`useOpenMadePage`). */
function useAgentPageInsertRun(): InsertActionRun {
  const openMadePage = useOpenMadePage();
  const fetchEndpoint = useFetchEndpoint();
  return ({ blockId, text }) => {
    openMadePage(
      turnIntoAgentPage(fetchEndpoint, blockId, agentPageTitle(text)),
      blockId,
    );
  };
}

/**
 * `/agent-page`: an agent-authored page made in place of the caret's line, the
 * line's other words becoming its title — listed right after the agent-notes
 * card, its sibling in the menu.
 */
export const agentPageInsertAction: InsertAction = {
  id: "agent-page",
  label: "Agent page",
  icon: autoAwesomeIcon,
  aliases: ["agent", "agent-page", "agent page", "ai page"],
  after: agentNotesBlock.type,
  useRun: useAgentPageInsertRun,
};
