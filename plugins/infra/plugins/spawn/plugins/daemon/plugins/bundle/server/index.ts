import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { bundleDaemon } from "./internal/bundle";
export type { DaemonBundle, DaemonBundleSpec } from "./internal/bundle";

export default {
  description:
    "bundleDaemon: a detached daemon's entry as a self-contained, content-addressed directory (<dir>/<hash>.bundle) — one Bun.build JS file per entry with repo code and pure-JS packages inlined, the scripts it runs by path (scriptPath literals) bundled beside it, the external packages cloned into its node_modules and the sealed dependency installs linked — held by a shared in-use flock the daemon inherits (launchDetached holdFds), so a process run from it reads nothing from the checkout it was made from; every call reclaims the bundles nothing holds.",
} satisfies ServerPluginDefinition;
