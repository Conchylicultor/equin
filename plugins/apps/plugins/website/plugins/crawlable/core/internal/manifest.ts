import { z } from "zod";

/**
 * One page's entry in the snapshot manifest.
 *
 * - `title` / `description` — the page's `defineWebsitePage` declaration,
 *   copied as is (the gateway writes `<title>` and `<meta name="description">`
 *   from them).
 * - `file` — the page's semantic HTML fragment, relative to the manifest's own
 *   directory (`<dist>/snapshot/`), never absolute and never escaping it.
 */
export const SnapshotPageSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    file: z
      .string()
      .regex(
        /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\]+\.html$/,
        "a .html path relative to the manifest's directory, never escaping it",
      ),
  })
  .strict();

/**
 * THE CONTRACT between the snapshot build (writer, `<dist>/snapshot/manifest.json`)
 * and the gateway (reader, `gateway/snapshot.go`): which request paths have a
 * static snapshot, and what to put in the shell's head for each.
 *
 * ```json
 * { "home": "/website", "pages": { "/website/download": { "title": "Download", "description": "…", "file": "website/download.html" } } }
 * ```
 *
 * - Keys are the exact page paths (`WebsitePage.path`: absolute, no trailing
 *   slash); the gateway normalizes a request's trailing slash before the lookup.
 * - A path absent from `pages` gets the plain SPA shell.
 * - Strict on both levels: a field the reader does not know is an error, so
 *   the two sides change together (the Go reader mirrors this shape).
 */
const PagePathSchema = z
  .string()
  .regex(/^\/[^?#]*[^/?#]$|^\/$/, "an absolute page path");

export const SnapshotManifestSchema = z
  .object({
    pages: z.record(PagePathSchema, SnapshotPageSchema),
    /**
     * The composition's home: the path bare `/` goes to (its home app's base
     * path). The gateway answers `GET /` with a 301 to it, so a robot reaches
     * the snapshot from the site's most-linked address. Never `/` itself,
     * and always one of `pages`. Absent: a composition with no home app.
     */
    home: PagePathSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.home === undefined) return;
    if (m.home === "/")
      ctx.addIssue({
        code: "custom",
        path: ["home"],
        message: "the home is where `/` goes, never `/` itself",
      });
    else if (!(m.home in m.pages))
      ctx.addIssue({
        code: "custom",
        path: ["home"],
        message: `the home ${m.home} is no page of the snapshot`,
      });
  });

export type SnapshotPage = z.infer<typeof SnapshotPageSchema>;
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

/** Where the manifest sits inside a web dist. */
export const SNAPSHOT_MANIFEST_PATH = "snapshot/manifest.json";
