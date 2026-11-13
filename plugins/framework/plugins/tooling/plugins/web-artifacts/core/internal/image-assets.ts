// Imported images are files of the artifact, never base64 in its JS.
//
// vite's library mode inlines every imported asset as a `data:` URL, whatever
// `assetsInlineLimit` says — so a page's screenshots used to ride inside its
// plugin's `index.js`: downloaded and parsed with the code on every route that
// loaded the plugin (shown or not), never cached apart from it, never decoded
// off-thread, never lazy-loaded.
//
// This plugin takes the image import before vite's asset plugin sees it: the
// file is emitted into the artifact beside its modules (the store dir is
// content-addressed, so its own name is enough; served like a worker chunk), and the module evaluates to `framework/image-import`'s
// `ImportedImage` — its URL resolved against the importing chunk's own URL,
// and its pixel size read from the file now, so the page reserves the box.

import type { Plugin as VitePlugin } from "vite";
import {
  IMAGE_IMPORT_RE,
  imageModuleCode,
  importedImageSize,
} from "@plugins/framework/plugins/image-import/core";

/**
 * The vite plugin emitting every imported image as a file of the artifact.
 * `readFile` is the builder's own (this module stays free of the filesystem).
 */
export function imageAssetsPlugin(
  readFile: (path: string) => Promise<Uint8Array>,
): VitePlugin {
  return {
    name: "web-artifacts:image-assets",
    enforce: "pre",
    async load(id) {
      // A query (`?raw`, `?url`, `?inline`) asks vite for something else.
      if (id.includes("?") || !IMAGE_IMPORT_RE.test(id)) return null;
      const bytes = await readFile(id);
      const size = importedImageSize(id, bytes);
      const ref = this.emitFile({
        type: "asset",
        name: id.slice(id.lastIndexOf("/") + 1),
        originalFileName: id,
        source: bytes,
      });
      return {
        code: imageModuleCode(`import.meta.ROLLUP_FILE_URL_${ref}`, size),
        moduleType: "js",
      };
    },
  };
}
