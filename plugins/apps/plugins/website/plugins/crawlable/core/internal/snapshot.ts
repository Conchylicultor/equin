import type { SnapshotManifest, SnapshotPage } from "./manifest";
import type { WebsitePage } from "./page";

/** A page whose snapshot cannot ship: names the page and why. */
export class SnapshotPageError extends Error {
  override name = "SnapshotPageError";
  constructor(
    readonly path: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`[crawlable] page ${path}: ${reason}`, options);
  }
}

/**
 * Where a page's fragment sits, relative to the manifest's directory: its path
 * without the leading slash, `.html` appended — `/about/download` →
 * `about/download.html`, `/about` → `about.html`. A page path is static
 * segments only (`defineWebsitePage`), so the name is a plain relative path
 * and two pages never share one.
 */
export function snapshotFileOf(path: string): string {
  if (!path.startsWith("/") || path === "/" || path.endsWith("/")) {
    throw new SnapshotPageError(path, "not an absolute page path");
  }
  return `${path.slice(1)}.html`;
}

/** The text a robot reads off a semantic fragment: tags dropped, whitespace collapsed. */
export function fragmentText(semantic: string): string {
  return semantic
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One page as the snapshot took it. */
export interface SnapshotTaken {
  page: WebsitePage;
  /** The browser document title the live app shows for it. */
  title: string;
  /** Its semantic HTML fragment (no `<html>` / `<body>` wrapper). */
  semantic: string;
}

/**
 * The manifest and fragment files of a snapshot, from its pages: each page
 * keyed by its path, its fragment at `snapshotFileOf(path)`, and `home` — the
 * path bare `/` goes to, the composition's home app's base path, `null` for
 * none — recorded when given, and `moved` — each former base path mapped to
 * where it moved — recorded when not empty. Throws a `SnapshotPageError` on a page with no
 * text (an empty render is no page a robot can read), a path taken twice, or
 * a home that is no taken page (`/` would redirect to a page with no
 * snapshot).
 */
export function snapshotFiles(
  taken: readonly SnapshotTaken[],
  home: string | null,
  moved: Readonly<Record<string, string>> = {},
): {
  manifest: SnapshotManifest;
  fragments: ReadonlyMap<string, string>;
} {
  const pages: Record<string, SnapshotPage> = {};
  const fragments = new Map<string, string>();
  for (const { page, title, semantic } of taken) {
    if (page.path in pages) {
      throw new SnapshotPageError(page.path, "declared twice");
    }
    if (fragmentText(semantic) === "") {
      throw new SnapshotPageError(
        page.path,
        "its static render holds no text — a robot would read an empty page",
      );
    }
    const file = snapshotFileOf(page.path);
    pages[page.path] = { title, description: page.description, file };
    fragments.set(file, semantic);
  }
  const movedPart =
    Object.keys(moved).length > 0 ? { moved: { ...moved } } : {};
  if (home === null) return { manifest: { pages, ...movedPart }, fragments };
  if (!(home in pages)) {
    throw new SnapshotPageError(
      home,
      "the composition's home is no declared page — `/` would redirect robots to a path with no snapshot",
    );
  }
  return { manifest: { home, pages, ...movedPart }, fragments };
}
