import { createAttachment } from "@plugins/infra/plugins/attachments/server";
import {
  decodeHtmlText,
  readHtmlAttr,
} from "@plugins/infra/plugins/html-decode/core";
import {
  parsePublicUrl,
  safeFetch,
  SsrfError,
} from "@plugins/infra/plugins/safe-fetch/server";
import type { LinkPreview } from "../../core";

const MAX_HTML_BYTES = 512 * 1024; // cap the HTML we parse
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // cap downloaded images
const USER_AGENT =
  "Mozilla/5.0 (compatible; SingularityBot/1.0; +link-preview)";

/**
 * The page answered with a non-2xx status: a determinate answer about that
 * url, which each reader maps to its own wire form (the link-meta endpoint's
 * 502, the link-preview value's `unreachable` refusal).
 */
export class PageFetchError extends Error {
  constructor(readonly status: number) {
    super(`Failed to fetch URL (status ${status})`);
    this.name = "PageFetchError";
  }
}

interface ScrapedMeta {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  faviconUrl?: string;
}

/**
 * Stream the HTML through Bun's built-in HTMLRewriter, accumulating the meta
 * fields we care about. We `.transform(res)` to get a streaming Response, then
 * `await transformed.text()` to drive the handlers to completion. A byte cap
 * stops accumulation once we've seen enough markup (handlers still run, but we
 * ignore further input).
 *
 * Every scraped value goes through `readHtmlAttr` / `decodeHtmlText` — the
 * rewriter hands back raw markup source, so an og:title reaches the preview card
 * as the literal `d&#x27;entretien` and an og:image URL's `&amp;` fetches the
 * wrong query string unless decoded exactly once. See
 * `@plugins/infra/plugins/html-decode` for why.
 */
async function parseMeta(
  res: Response,
  finalUrl: string,
): Promise<ScrapedMeta> {
  const meta: ScrapedMeta = {};
  const ogImageCandidates: { og?: string; twitter?: string } = {};
  const titleCandidates: { og?: string; twitter?: string; tag?: string } = {};
  const descCandidates: { og?: string; twitter?: string; meta?: string } = {};

  let bytesSeen = 0;
  let inHeadTitle = false;
  let titleText = "";

  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(el) {
        if (bytesSeen > MAX_HTML_BYTES) return;
        const property = readHtmlAttr(el, "property")?.toLowerCase();
        const name = readHtmlAttr(el, "name")?.toLowerCase();
        const content = readHtmlAttr(el, "content");
        if (!content) return;
        const key = property ?? name;
        if (!key) return;
        switch (key) {
          case "og:title":
            titleCandidates.og ??= content;
            break;
          case "twitter:title":
            titleCandidates.twitter ??= content;
            break;
          case "og:description":
            descCandidates.og ??= content;
            break;
          case "twitter:description":
            descCandidates.twitter ??= content;
            break;
          case "description":
            descCandidates.meta ??= content;
            break;
          case "og:site_name":
            meta.siteName ??= content;
            break;
          case "og:image":
          case "og:image:url":
          case "og:image:secure_url":
            ogImageCandidates.og ??= content;
            break;
          case "twitter:image":
          case "twitter:image:src":
            ogImageCandidates.twitter ??= content;
            break;
          default:
            break;
        }
      },
    })
    .on("link", {
      element(el) {
        if (bytesSeen > MAX_HTML_BYTES) return;
        const rel = readHtmlAttr(el, "rel")?.toLowerCase() ?? "";
        const href = readHtmlAttr(el, "href");
        if (!href) return;
        // rel may be a space-separated token list (e.g. "shortcut icon").
        const rels = rel.split(/\s+/);
        if (rels.includes("icon") && !meta.faviconUrl) {
          meta.faviconUrl = href;
        }
      },
    })
    .on("title", {
      element() {
        if (bytesSeen > MAX_HTML_BYTES) return;
        inHeadTitle = true;
      },
      text(chunk) {
        if (!inHeadTitle) return;
        titleText += chunk.text;
        if (chunk.lastInTextNode) inHeadTitle = false;
      },
    })
    .on("*", {
      // Cheap running byte counter so we stop honoring elements once we've seen
      // enough of the document head.
      element() {
        bytesSeen += 1;
      },
    });

  const transformed = rewriter.transform(res);
  await transformed.text(); // drive the stream to completion

  // Decoded once over the WHOLE accumulated string, never per chunk: the rewriter
  // splits text on its own buffer boundaries, so a character reference can straddle
  // two chunks and only reassembles here.
  titleCandidates.tag = decodeHtmlText(titleText).trim() || undefined;
  meta.title =
    titleCandidates.og ?? titleCandidates.twitter ?? titleCandidates.tag;
  meta.description =
    descCandidates.og ?? descCandidates.twitter ?? descCandidates.meta;

  const rawImage = ogImageCandidates.og ?? ogImageCandidates.twitter;
  meta.imageUrl = resolveUrl(rawImage, finalUrl);

  // Favicon: resolve the discovered <link rel=icon>, else default to /favicon.ico.
  if (meta.faviconUrl) {
    meta.faviconUrl = resolveUrl(meta.faviconUrl, finalUrl);
  } else {
    try {
      meta.faviconUrl = new URL("/favicon.ico", finalUrl).toString();
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      meta.faviconUrl = undefined;
    }
  }
  return meta;
}

function resolveUrl(
  value: string | undefined,
  base: string,
): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).toString();
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return undefined;
  }
}

/**
 * Best-effort download of a remote image into an attachment. Degrades to
 * `undefined` for any expected condition (missing/oversized/non-image/blocked)
 * — a missing image just means no imageId, not an error.
 */
async function cacheImage(
  rawUrl: string | undefined,
  fallbackName: string,
): Promise<string | undefined> {
  if (!rawUrl) return undefined;
  let parsed: URL;
  try {
    parsed = parsePublicUrl(rawUrl);
  } catch (err) {
    if (!(err instanceof SsrfError)) throw err;
    return undefined;
  }
  const headers = { "user-agent": USER_AGENT };
  // eslint-disable-next-line promise-safety/no-absorbed-failure -- best-effort OG-image scrape; undefined means "no preview image", the correct degraded result (guarded below by `if (!res || !res.ok) return undefined`), not a swallowed data failure
  const res = await safeFetch(parsed, { headers }).catch(() => undefined);
  if (!res || !res.ok) return undefined;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return undefined;

  const buf = await res.arrayBuffer().catch(() => undefined);
  if (!buf) return undefined;
  if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES)
    return undefined;

  const mime = contentType.split(";")[0]?.trim() || "application/octet-stream";
  const name = fileNameFor(parsed, fallbackName, mime);
  const attachment = await createAttachment(new Uint8Array(buf), name, mime);
  return attachment.id;
}

function fileNameFor(url: URL, fallback: string, mime: string): string {
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = mime.split("/")[1]?.split("+")[0] ?? "img";
  return `${fallback}.${ext}`;
}

/**
 * Fetch `url` (SSRF-guarded) and parse its metadata — and nothing more. Downloads
 * no image: a caller that only wants the title (the pasted-link Mention) must not
 * mint the two attachments `scrapeLinkPreview` caches, which only a bookmark
 * block ever links and the orphan sweep would otherwise reclaim.
 *
 * `imageUrl` / `faviconUrl` come back resolved against the final (post-redirect)
 * URL, ready for `scrapeLinkPreview` to cache.
 */
export async function scrapeLinkMeta(url: string): Promise<ScrapedMeta> {
  const target = parsePublicUrl(url);

  const res = await safeFetch(target, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!res.ok) throw new PageFetchError(res.status);

  // The final URL after redirects, used to resolve relative image/favicon paths.
  const finalUrl = res.url || target.toString();
  return parseMeta(res, finalUrl);
}

/** `scrapeLinkMeta`, plus the og:image and favicon cached as attachments. */
export async function scrapeLinkPreview(url: string): Promise<LinkPreview> {
  const meta = await scrapeLinkMeta(url);

  // Download og:image + favicon best-effort. Degrade gracefully on missing.
  const [imageId, faviconId] = await Promise.all([
    cacheImage(meta.imageUrl, "preview"),
    cacheImage(meta.faviconUrl, "favicon"),
  ]);

  return {
    title: meta.title,
    description: meta.description,
    siteName: meta.siteName,
    imageId,
    faviconId,
  };
}
