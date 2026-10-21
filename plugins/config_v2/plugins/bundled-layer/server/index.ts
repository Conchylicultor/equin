import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigGitLayer } from "@plugins/config_v2/server";
import { bundledConfigLayer } from "./internal/bundled";

export default {
  description:
    "The committed config layer bundled as text: provides the ConfigGitLayer host service from the repo's config/ inlined at build time, for a host without the repo on disk (a browser worker host). Never booted by the desktop, which reads the checkout's config/ (config_v2#machine).",
  portable: true,
  contributions: [ConfigGitLayer.provide(bundledConfigLayer)],
} satisfies ServerPluginDefinition;
