import type { WebsitePage } from "../../core";

/**
 * The origin a request was made to, as the visitor typed it. The gateway
 * rewrites `Host` to its backend when proxying and stamps the visitor's host in
 * `X-Forwarded-Host` (overwriting any client value), so that header wins and
 * `Host` is the fallback for a request that reached the server directly. The
 * scheme is the one `X-Forwarded-Proto` reports — `http` when nothing says
 * otherwise. Throws on a request with neither header: a sitemap of relative
 * URLs is not a sitemap.
 */
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host === null || host === "") {
    throw new Error(
      `${req.method} ${new URL(req.url).pathname}: no X-Forwarded-Host or Host header`,
    );
  }
  const forwarded = req.headers.get("x-forwarded-proto");
  // A proxy chain lists one scheme per hop; the first is the visitor's.
  const proto = forwarded?.split(",")[0]?.trim().toLowerCase();
  const scheme = proto === "https" ? "https" : "http";
  return `${scheme}://${host}`;
}

/** robots.txt: every agent may read everything; the sitemap says what there is. */
export function renderRobotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

/** sitemap.xml: one `<url><loc>` per page, sorted by path so it is stable. */
export function renderSitemapXml(
  origin: string,
  pages: readonly WebsitePage[],
): string {
  const urls = [...pages]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((p) => `  <url><loc>${xmlEscape(origin + p.path)}</loc></url>\n`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls +
    `</urlset>\n`
  );
}
