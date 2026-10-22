import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  plainOf,
  turnIntoPage,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { textBlock } from "@plugins/page/plugins/text/core";

/**
 * `/instructions page`: turn the caret's line into an instructions page, in
 * place — the same atomic server op as "Turn into → Page", with the page's kind
 * chosen at birth (`kind: instructions`, not global; the page header's control
 * turns Global on). The line's other words become the title, trimmed (the cut
 * leaves the space that stood before the `/`), exactly as `/agent-page` does.
 *
 * `seedChild` comes from here for the reason `turn-into-page` gives: the editor
 * may not import a concrete block type.
 */
export async function turnIntoInstructionsPage(
  fetchEndpoint: FetchEndpoint,
  blockId: string,
  text: RichText,
): Promise<void> {
  await fetchEndpoint(
    turnIntoPage,
    { id: blockId },
    {
      body: {
        title: plainOf(text).trim(),
        kind: { kind: "instructions", global: false },
        seedChild: {
          type: textBlock.type,
          data: textBlock.schema.parse({ text: [] }),
        },
      },
    },
  );
}
