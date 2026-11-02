import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { SecretStore } from "@plugins/infra/plugins/secrets/server";
import { centralSecretStore } from "./internal/central-store";

export { centralSecretStore } from "./internal/central-store";

export default {
  description:
    "Secrets, desktop-only half: provides the SecretStore host service as a client of central's encrypted store, over HTTP through the gateway (http://localhost:9000/api/secrets/*) — central unreachable (no answer twice, a gateway 502/503/504, or its 404 before the central-routes manifest loaded) is SecretsMainOfflineError.",
  loadBearing: true,
  contributions: [SecretStore.provide(centralSecretStore)],
} satisfies MachinePluginDefinition;
