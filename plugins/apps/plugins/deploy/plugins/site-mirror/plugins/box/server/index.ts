import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MirrorReaderRoutes } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  mirrorChangesEndpoint,
  mirrorCopyEndpoint,
  mirrorKeysEndpoint,
  mirrorRowsEndpoint,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";
import {
  handleMirrorChanges,
  handleMirrorCopy,
  handleMirrorKeys,
  handleMirrorRows,
} from "./internal/routes";

export default {
  description:
    "Ships on the deployed box: the host-only table-mirror routes — changes, copy, keys and rows, each one page of table-mirror/source's readers for a set this release contributes (unknown-set otherwise), behind hostOnly and Caddy's host-only 404. A companion of table-mirror/source (MirrorReaderRoutes), so every composition holding a mirror set serves its readers.",
  httpRoutes: {
    [mirrorChangesEndpoint.route]: handleMirrorChanges,
    [mirrorCopyEndpoint.route]: handleMirrorCopy,
    [mirrorKeysEndpoint.route]: handleMirrorKeys,
    [mirrorRowsEndpoint.route]: handleMirrorRows,
  },
  contributions: [
    MirrorReaderRoutes({
      companion: true,
      reason:
        "apps/deploy/site-mirror/box serves the readers as host-only routes, curled over SSH by the deploy app's site-mirror/pull",
    }),
  ],
} satisfies ServerPluginDefinition;
