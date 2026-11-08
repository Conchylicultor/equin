import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * Files' data dir (`apps/file-explorer`, `../../../../data-dirs`) as a file
 * root: the user's Documents, on whatever host runs — the computer's disk on
 * the desktop (bound in `../../machine`), memory in a browser host.
 *
 * - `watch` — what App data shows is pushed from it. No `extensions`: a
 *   document may be of any kind, and every change is one a listing shows.
 * - `browse` — read-only in the file explorer's App data place.
 */
export const documentsFiles = defineFileRoot({
  id: "apps.file-explorer.documents",
  dir: "apps/file-explorer",
  watch: {
    name: "file-explorer-documents.tree",
    description:
      "Watches the Documents folder so Files' App data listing and open files follow every change.",
  },
  browse: { label: "Documents" },
});
