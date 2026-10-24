import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  createCustomPlace,
  deletePlace,
  regeneratePlaceIcon,
  savePlace,
  updatePlace,
} from "../../core";
import {
  createCustomPlace as dropCustomPlace,
  deletePlace as removePlace,
  requirePlace,
  savePlace as insertPlace,
  updatePlace as editPlace,
} from "./places-repo";
import { generatePlaceIcon } from "./place-icon";

export const handleSavePlace = implement(savePlace, async ({ body }) =>
  insertPlace(body),
);

export const handleCreateCustomPlace = implement(
  createCustomPlace,
  async ({ body }) => dropCustomPlace(body),
);

export const handleUpdatePlace = implement(
  updatePlace,
  async ({ params, body }) => editPlace(params.id, body),
);

export const handleDeletePlace = implement(deletePlace, async ({ params }) => {
  await removePlace(params.id);
});

// Awaited in-request rather than enqueued, so the Regenerate button's pending
// state is exactly the pick's lifetime. 404s on an unknown place first.
export const handleRegeneratePlaceIcon = implement(
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
