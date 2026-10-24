import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { regeneratePageIcon } from "../../shared/endpoints";
import { generatePageIcon } from "./generate-icon";

// Awaited in-request rather than enqueued, so the Regenerate button's pending
// state cannot outlive the pick. A pick that writes nothing is a failure, thrown
// so the client's error toast says so.
export const handleRegeneratePageIcon = implementMachine(
  regeneratePageIcon,
  async ({ params }) => {
    const result = await generatePageIcon(params.pageId, { force: true });
    if (result.kind !== "written") {
      throw new Error(`Could not regenerate the icon: ${result.reason}`);
    }
    return { emoji: result.emoji };
  },
);
