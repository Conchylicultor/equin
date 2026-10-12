import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploymentServed } from "./internal/deployment-resource";
import { chainFromServed } from "./internal/chain-from-resource";
import { sealServerPin } from "./internal/server-pin";

export {
  readDeployment,
  readDeploymentState,
} from "./internal/read-deployment";
export { deploymentServed } from "./internal/deployment-resource";
export { serverPin } from "./internal/server-pin";

export default {
  description:
    "The deployment description: this checkout's HEAD (the target) plus a pin per deployable carrier — the backend process and the frontend bundle it serves — and the one derived verdict (converged / behind / diverged / unknown) both the Build button and the auto-build decision read. A leaf: it never imports build/server, so the reconciler that owns triggerBuild can import DOWN into it.",
  contributions: [...deploymentServed.declare, ...chainFromServed.declare],
  onAllReady: async () => {
    // Seal the server pin here, not in `onReady`: this is the first point at
    // which every plugin's import is behind us, so re-sampling HEAD now answers
    // "did the checkout move under the import wave?" over the whole wave. A
    // difference makes the pin `unresolved("mixed boot")`, which reads as not
    // converged and forces a rebuild + restart.
    sealServerPin();
    // Push the sealed answer: subscribers that hydrated from the boot snapshot
    // hold the pre-seal value.
    deploymentServed.notify();
  },
} satisfies ServerPluginDefinition;
