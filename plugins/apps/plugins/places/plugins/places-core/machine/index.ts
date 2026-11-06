import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { regeneratePlaceIcon, savePlace } from "../core";
import { PlaceIconPicker } from "../server";
import { haikuIconPicker } from "./internal/haiku-picker";
import {
  handleRegeneratePlaceIcon,
  handleSavePlace,
} from "./internal/handlers";
import { refreshPlacesJob } from "./internal/refresh-job";
import { placeSearchServed } from "./internal/resources";

export { searchPlaces } from "./internal/google-places";

export default {
  description:
    "The Places app's desktop half — what needs Google's Places API (the computer's Places key) or the Claude CLI: Google Places search and save (auto-tagged from the place's Google types, tagged Want to go), the monthly job that re-fetches each place's Google details (whether it is still open), the Haiku icon picker (PlaceIconPicker) and Regenerate. Search, save and Regenerate are needsMachine.",
  register: [refreshPlacesJob],
  httpRoutes: {
    [savePlace.route]: handleSavePlace,
    [regeneratePlaceIcon.route]: handleRegeneratePlaceIcon,
  },
  contributions: [
    PlaceIconPicker.provide(haikuIconPicker),
    ...placeSearchServed.declare,
  ],
} satisfies MachinePluginDefinition;
