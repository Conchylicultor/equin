import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";
import { adoptCentralDeploy } from "../core";
import { handleCentralAdopt } from "./internal/handle-adopt";

export default {
  description:
    "Restart-skip, central's half: POST /api/restart-skip/central/adopt — main's deploy asks central before restarting it, and central answers adopted only when a process spawned now would run exactly its code (the same judgement as a backend's: same Bun and entry, nothing it loaded or could still load changed since it started).",
  httpRoutes: {
    [adoptCentralDeploy.route]: handleCentralAdopt,
  },
} satisfies CentralPluginDefinition;
