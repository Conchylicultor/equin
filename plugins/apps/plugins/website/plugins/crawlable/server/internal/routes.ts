import type { HttpHandler } from "@plugins/framework/plugins/server-core/core";
import type { WebsitePage } from "../../core";
import { WebsitePages } from "./pages";
import { renderRobotsTxt, renderSitemapXml, requestOrigin } from "./render";

/**
 * Both files exist only where the composition declares pages: a composition
 * without the website answers 404 — which a crawler reads as "no rules",
 * i.e. allow-all — rather than a robots.txt pointing at an empty sitemap.
 */
function withPages(
  answer: (req: Request, pages: readonly WebsitePage[]) => Response,
): HttpHandler {
  return (req) => {
    const pages = WebsitePages.Page.getContributions();
    if (pages.length === 0) {
      return new Response("Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return answer(req, pages);
  };
}

export const handleRobotsTxt = withPages(
  (req) =>
    new Response(renderRobotsTxt(requestOrigin(req)), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
);

export const handleSitemapXml = withPages(
  (req, pages) =>
    new Response(renderSitemapXml(requestOrigin(req), pages), {
      headers: { "content-type": "application/xml; charset=utf-8" },
    }),
);
