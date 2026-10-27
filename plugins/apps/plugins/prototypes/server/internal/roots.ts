import { relPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * The app's one data dir (`apps/prototypes`, `../../data-dirs`) as a file
 * root: the prototype folders, `_history/` and `_picks/`, on whatever host
 * runs — the computer's disk on the desktop (bound in `../../machine`), memory
 * in a browser host. Every sub-plugin reads and writes the tree through it.
 *
 * - `watch` — the one watcher over the tree (`files` subscribes; `thumbnails`
 *   hears `files`' signal rather than watching twice). Every extension a
 *   self-contained prototype can ship, no `.jsx` (JSX lives inline: Babel
 *   fetches an external `src` with XHR, which Chrome blocks over `file://`).
 *   `.json` also passes each history's `latest.json` stamp — git's own files
 *   carry no extension — and each `_picks/<id>.json`; a write's temp file and a
 *   `.lock` do not pass. A dropped fsevent is reported by the watch itself
 *   (`onLost`, delivered as a `rescan`) — there is no reconcile timer; `files`
 *   gates every reaction on the folders' signature.
 * - `ledger` — an automated session's option picks are put back when its run
 *   ends (an E2E that clicks the picker must not leave the user on another
 *   variant).
 * - `browse` — read-only in the file explorer's App data place.
 */
export const prototypesFiles = defineFileRoot({
  id: "apps.prototypes",
  dir: "apps/prototypes",
  watch: {
    name: "prototypes-files.tree",
    description:
      "Watches the prototypes folder and reloads open prototypes, their history and picks when a file really changes.",
    extensions: [
      ".html",
      ".css",
      ".js",
      ".json",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".woff2",
    ],
  },
  ledger: {
    id: "prototype-picks",
    label: "Prototype option picks",
    under: relPath("_picks"),
  },
  browse: { label: "Prototypes" },
});
