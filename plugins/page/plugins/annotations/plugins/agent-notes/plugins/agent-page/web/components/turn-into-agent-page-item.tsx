import type { MouseEvent } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { BlockEditorAPI } from "@plugins/page/plugins/editor/web";
import type { Block } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { turnIntoAgentPage } from "../internal/turn-into-agent-page";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * "Agent page" in an agent card's block-actions "Turn into" section: the card
 * becomes an agent-authored page in place — same id, same position, so the
 * authorship rows keyed by its id carry over and the page's creator chip names
 * the conversation that wrote the card. Its first line becomes the title; the
 * rest of its lines become the page's content.
 *
 * Styled like turn-into-page's "Page" row (icon + label, `onMouseDown` +
 * `preventDefault` so it does not blur the editor before the action runs), and
 * like it, it calls the atomic server op and relies on the live push for the
 * result: the transition re-scopes the card's subtree into a new page, which no
 * optimistic op on this page's lane can predict.
 */
export function TurnIntoAgentPageItem({
  block,
  close,
}: {
  block: Block;
  api: BlockEditorAPI;
  close: () => void;
}) {
  const fetchEndpoint = useFetchEndpoint();
  return (
    <Row
      icon={<Icon icon={autoAwesomeIcon} className="text-muted-foreground" />}
      onMouseDown={(e: MouseEvent) => {
        e.preventDefault();
        void turnIntoAgentPage(fetchEndpoint, block.id, {
          fromFirstChild: true,
        });
        close();
      }}
    >
      Agent page
    </Row>
  );
}
