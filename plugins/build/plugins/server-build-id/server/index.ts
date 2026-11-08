import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
export { getServerCommit } from "./internal/get-server-commit";
export { getServerGraphHash } from "./internal/get-server-graph-hash";
export {
  adoptServerPin,
  sealServerPin,
  serverPin,
  serverPinCommit,
} from "./internal/server-pin";
import {
  clientBuildIdentityRegistration,
  pinClientBuildIdentity,
} from "./internal/client-build-identity";
import { RestartSkip } from "@plugins/build/plugins/restart-skip/plugins/hooks/server";
export default {
  description:
    "Served-bundle and server pin leaf: the commit this backend process was materialized from (serverPin — HEAD sampled at module eval, sealed by build/deployment at onAllReady, unresolved on a mixed boot), and reads the .build-commit (the tree the bundle was built from) and .build-graph (content identity of the served web graph) trailers out of the served dist, fresh on every call; also registers the boot-memoized graph as the live-resource runtime's build identity (contract-mismatch verdicts), re-read when the backend adopts a deploy instead of restarting (restart-skip). A leaf so the deployment description and stale-tab detection read them without importing the heavy build barrel (which pulls git-watcher/worktree).",
  contributions: [
    RestartSkip.Adopted({
      what: "the web graph live-resource contract verdicts are judged against",
      adopt: pinClientBuildIdentity,
    }),
  ],
  register: [clientBuildIdentityRegistration],
} satisfies ServerPluginDefinition;
