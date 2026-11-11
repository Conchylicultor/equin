/**
 * Image imports evaluate to what the browser build gives them: a `data:` URL.
 *
 * The web build is vite in library mode (`tooling/web-artifacts`), which
 * inlines every imported asset into the module as a base64 `data:` URL — there
 * is no separate served file, so the data URL IS the served URL. Bun's own
 * loader would instead hand back the file's absolute path on this machine,
 * which a page rendered here (the crawlable website's static snapshot) would
 * then ship as an `<img src>` no visitor can load.
 *
 * Opt-in, for a process that renders what it loads: a docgen or record pass
 * reads no image, and keeping image bytes out of evaluated barrels keeps them
 * out of the records keyed by module code alone.
 */

/** The image types an import may name, and the MIME type each is served as. */
export const INLINED_ASSET_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/** `bytes` as the `data:` URL an import of a `.<ext>` file evaluates to. */
export function assetDataUrl(ext: string, bytes: Uint8Array): string {
  const mime = INLINED_ASSET_MIME[ext.toLowerCase()];
  if (mime === undefined) {
    throw new Error(`[barrel-import] no inlined asset type for ".${ext}"`);
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

let inlined = false;

/**
 * Make every later import of an image file (`import shot from "./x.jpg"`)
 * evaluate to its `data:` URL, as the browser build's does. Idempotent; call
 * before the first import that may reach an image.
 */
export function inlineAssetImports(): void {
  if (inlined) return;
  inlined = true;
  const filter = new RegExp(
    `\\.(${Object.keys(INLINED_ASSET_MIME).join("|")})$`,
    "i",
  );
  Bun.plugin({
    name: "barrel-import-inline-assets",
    setup(build) {
      build.onLoad({ filter }, async ({ path }) => {
        const ext = path.slice(path.lastIndexOf(".") + 1);
        // Bun.file: an asset is data, not a module the load guard watches.
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
        return {
          contents: `export default ${JSON.stringify(assetDataUrl(ext, bytes))};`,
          loader: "js",
        };
      });
    },
  });
}
