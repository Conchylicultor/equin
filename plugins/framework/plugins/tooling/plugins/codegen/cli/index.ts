import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * Re-propagate this checkout's git-layer config into one namespace's user
 * config directory (`propagateConfigToUser`, the build's own propagation stage).
 * What a serving backend runs to restore a namespace's first-launch config
 * (serve-composition's reset): finding every config means evaluating every
 * plugin barrel — build tooling, loaded by computed paths — so it happens in
 * this process, never in the backend's (`boot:closure-digestable`).
 */
export default defineCliCommand<[string], object>({
  name: "config-propagate",
  description:
    "Propagate this checkout's git-layer config defaults into <user-config-dir> (a namespace's user config layer), replaying pending config migrations first",
  arguments: [
    {
      name: "user-config-dir",
      description: "the namespace's user config directory, already resolved",
    },
  ],
  run: () => import("./run"),
});
