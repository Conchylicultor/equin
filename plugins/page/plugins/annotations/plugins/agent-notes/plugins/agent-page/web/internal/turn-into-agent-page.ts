import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  turnIntoPage,
  type TurnIntoPageBody,
} from "@plugins/page/plugins/editor/core";
import { textBlock } from "@plugins/page/plugins/text/core";

/**
 * Turn block `blockId` into an agent-authored page, in place — the same atomic
 * server op as "Turn into → Page", with the page marked `author: "agent"` at
 * birth (`kind: agent-page`). The server's turn-into-page is the one place a
 * page's author is chosen; every later data write keeps it.
 *
 * Two callers, differing only in where the title comes from:
 *
 * - `/agent-page` passes the caret line's own words (`agentPageTitle`), exactly
 *   as "Turn into → Page" makes a block's text its title — so `notes
 *   /agent-page` is an agent page titled `notes`, and nothing the user typed
 *   disappears; an otherwise-empty line gives an untitled page, the slot a
 *   human makes for an agent to fill and name.
 * - the agent card's Turn into → Agent page passes `{ fromFirstChild: true }`:
 *   a card owns no line of its own, so its FIRST line (its first child) becomes
 *   the title and leaves the content, the rest of the card becoming the page.
 *
 * `seedChild` comes from here for the reason `turn-into-page` gives: the editor
 * may not import a concrete block type, and a page with no child renders nothing
 * typeable.
 */
export async function turnIntoAgentPage(
  blockId: string,
  title: TurnIntoPageBody["title"],
): Promise<void> {
  await fetchEndpoint(
    turnIntoPage,
    { id: blockId },
    {
      body: {
        title,
        kind: { kind: "agent-page" },
        seedChild: {
          type: textBlock.type,
          data: textBlock.schema.parse({ text: [] }),
        },
      },
    },
  );
}
