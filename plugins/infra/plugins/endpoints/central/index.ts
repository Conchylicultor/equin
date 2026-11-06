import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";

export { implementCentral } from "./internal/implement-central";

export default {
  description:
    "Typed endpoint contract primitive, central half: implementCentral() creates central's handler of an endpoint declared needsMachine — central runs only on the computer, so it serves what a host without one answers not available.",
} satisfies CentralPluginDefinition;
