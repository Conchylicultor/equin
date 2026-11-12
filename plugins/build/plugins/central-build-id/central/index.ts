import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";
import { centralBuildIdentityRegistration } from "./internal/central-build-identity";

export default {
  description:
    "Central's code build, central's half: at register, starts the source digest of the entry central runs and, once it lands, names it as the central live-resource runtime's build (setCentralBuildIdentity) — the `graph` on central's ack frames and read envelopes a tab judges an undecodable central value against. Unknown (no `graph`, judged `unknown`: loud) until then, or when it cannot be computed.",
  register: [centralBuildIdentityRegistration],
} satisfies CentralPluginDefinition;
