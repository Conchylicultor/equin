import {
  IMAGE_IMPORT_RE,
  imageDataUrl,
  imageModuleCode,
  importedImageSize,
} from "@plugins/framework/plugins/image-import/core";

/**
 * Image imports evaluate to what the browser build gives them: an
 * `ImportedImage` (`framework/image-import`) — here with a `data:` URL.
 *
 * The web build emits each imported image as a file of its artifact, at a URL
 * only the deployed import map knows; a Bun process has no such URL. Bun's own
 * loader would hand back the file's absolute path on this machine as a bare
 * string, which a page rendered here (the crawlable website's static snapshot)
 * would then ship as an `<img src>` no visitor can load — and with no size.
 * So the `src` is the image's `data:` URL and the size is read from its
 * header, as the build does.
 *
 * Opt-in, for a process that renders what it loads: a docgen or record pass
 * reads no image, and keeping image bytes out of evaluated barrels keeps them
 * out of the records keyed by module code alone.
 */

let inlined = false;

/**
 * Make every later import of an image file (`import shot from "./x.jpg"`)
 * evaluate to its `ImportedImage`, as the browser build's does. Idempotent;
 * call before the first import that may reach an image.
 */
export function inlineAssetImports(): void {
  if (inlined) return;
  inlined = true;
  Bun.plugin({
    name: "barrel-import-inline-assets",
    setup(build) {
      build.onLoad({ filter: IMAGE_IMPORT_RE }, async ({ path }) => {
        // Bun.file: an asset is data, not a module the load guard watches.
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
        return {
          contents: imageModuleCode(
            JSON.stringify(imageDataUrl(path, bytes)),
            importedImageSize(path, bytes),
          ),
          loader: "js",
        };
      });
    },
  });
}
