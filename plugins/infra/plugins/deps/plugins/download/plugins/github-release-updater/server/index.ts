import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { UpdaterDeclare } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { githubReleaseUpdater } from "./internal/github-release-updater";

// A sub-plugin of its own so the download installer kind does not import the
// updater registry, which files tasks (the python/uv-updater split).

export default {
  description:
    "The github-release updater: moves every githubReleaseDownload's pin (a JSON file beside its declaration: tag, publish instant, asset sha256) to the repository's newest release past a 3-day cooldown, honouring reviewed holds, contributed to the infra/deps updater registry.",
  contributions: [UpdaterDeclare({ updater: githubReleaseUpdater })],
} satisfies ServerPluginDefinition;
