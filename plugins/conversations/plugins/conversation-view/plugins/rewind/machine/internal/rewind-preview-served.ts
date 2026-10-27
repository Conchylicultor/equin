import { serveValue } from "@plugins/network/plugins/live/machine";
import { previewRewind } from "@plugins/conversations/server";
import { rewindPreview } from "../../core/resources";

/** The cut, measured on every ask; a message that cannot be cut is refused. */
export const rewindPreviewServed = serveValue(rewindPreview, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a cut of the agent's transcript, taken when the Rewind / Fork click asks — the transcript moves with every turn",
    },
  },
  loader: async ({ id, uuid }) => {
    const preview = await previewRewind(id, uuid);
    if (!preview.ok)
      throw rewindPreview.refuse(preview.reason, preview.message);
    const { messageText, losses, inPlace, turnRunning } = preview;
    return { messageText, losses, inPlace, turnRunning };
  },
});
