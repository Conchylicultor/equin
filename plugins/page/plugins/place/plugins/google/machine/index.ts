import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { googlePlaceProvider } from "./internal/provider";
import { unknownTypeKind } from "./internal/unknown-type-kind";

export default {
  description:
    "Google Places provider for the /place block: adapts the Places API client (autocomplete + details) onto the place-provider registry, reading the API key through the Google Maps integration. Colours a place by the Table A heading of its type (a vendored copy of Google's place-type table), filing a place-google-unknown-type report when Google returns a type the copy lacks.",
  register: [googlePlaceProvider],
  contributions: [unknownTypeKind],
} satisfies MachinePluginDefinition;
