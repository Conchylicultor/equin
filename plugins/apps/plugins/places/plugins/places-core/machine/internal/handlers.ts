import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { regeneratePlaceIcon, savePlace } from "../../core";
import { requirePlace } from "../../server/internal/places-repo";
import { generatePlaceIcon } from "../../server/internal/place-icon";
import { savePlace as saveGooglePlace } from "./google-places";

export const handleSavePlace = implementMachine(savePlace, async ({ body }) =>
  saveGooglePlace(body),
);

// Awaited in-request rather than enqueued, so the Regenerate button's pending
// state is exactly the pick's lifetime. 404s on an unknown place first.
export const handleRegeneratePlaceIcon = implementMachine(
  regeneratePlaceIcon,
  async ({ params }) => {
    await requirePlace(params.id);
    const result = await generatePlaceIcon(params.id, { force: true });
    if (result.kind === "skipped") {
      throw new Error(`Could not regenerate the icon: ${result.reason}`);
    }
    return result;
  },
);
