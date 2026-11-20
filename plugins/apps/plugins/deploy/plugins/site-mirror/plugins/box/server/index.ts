import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MirrorReaderRoutes } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { BoxSignal } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/box/server";
import {
  MIRROR_BOX_SIGNAL_SOURCE,
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
import { subscribeMirrorSignal } from "./internal/signal";

export default {
  description:
    "Ships on the deployed box: the host-only table-mirror routes — changes, copy, keys and rows, each one page of table-mirror/source's readers for a set this release contributes (unknown-set otherwise), behind hostOnly and Caddy's host-only 404. A companion of table-mirror/source (MirrorReaderRoutes), so every composition holding a mirror set serves its readers — and, through its import of box-link/box, the box-link stream, to which it contributes the table-mirror signal: { setId } whenever a set's source log advanced, throttled to one ring per set per 2 s.",
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
    // The doorbell: the computer holding the box link pulls the set it names.
    BoxSignal({
      source: MIRROR_BOX_SIGNAL_SOURCE,
      subscribe: subscribeMirrorSignal,
    }),
  ],
} satisfies ServerPluginDefinition;
