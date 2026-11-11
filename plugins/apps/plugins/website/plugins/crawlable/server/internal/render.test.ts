import { describe, expect, test } from "bun:test";
import { defineWebsitePage } from "../../core";
import { renderRobotsTxt, renderSitemapXml, requestOrigin } from "./render";

const req = (headers: Record<string, string>) =>
  new Request("http://backend/robots.txt", { headers });

describe("requestOrigin", () => {
  test("the Host header, over http when nothing says otherwise", () => {
    expect(requestOrigin(req({ host: "website.localhost:9000" }))).toBe(
      "http://website.localhost:9000",
    );
  });

  test("the scheme X-Forwarded-Proto reports (first hop of a chain)", () => {
    expect(
      requestOrigin(req({ host: "equin.ai", "x-forwarded-proto": "https" })),
    ).toBe("https://equin.ai");
    expect(
      requestOrigin(
        req({ host: "equin.ai", "x-forwarded-proto": "HTTPS, http" }),
      ),
    ).toBe("https://equin.ai");
  });

  test("the visitor's host from X-Forwarded-Host wins over the proxied Host", () => {
    expect(
      requestOrigin(
        req({
          host: "backend",
          "x-forwarded-host": "equin.ai",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://equin.ai");
  });

  test("an empty X-Forwarded-Host falls back to Host", () => {
    expect(
      requestOrigin(
        req({ host: "website.localhost:9000", "x-forwarded-host": "" }),
      ),
    ).toBe("http://website.localhost:9000");
  });

  test("an unknown scheme falls back to http", () => {
    expect(
      requestOrigin(req({ host: "equin.ai", "x-forwarded-proto": "ftp" })),
    ).toBe("http://equin.ai");
  });

  test("throws with neither header", () => {
    // `new Request` adds no Host of its own.
    expect(() => requestOrigin(req({}))).toThrow(/no X-Forwarded-Host or Host/);
  });
});

describe("renderRobotsTxt", () => {
  test("allows everything and points at the sitemap", () => {
    expect(renderRobotsTxt("https://equin.ai")).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://equin.ai/sitemap.xml\n",
    );
  });
});

describe("renderSitemapXml", () => {
  const page = (path: string) =>
    defineWebsitePage({ path, title: "T", description: "D." });

  test("one <url><loc> per page, sorted by path", () => {
    expect(
      renderSitemapXml("https://equin.ai", [
        page("/website/download"),
        page("/website"),
      ]),
    ).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>https://equin.ai/website</loc></url>\n` +
        `  <url><loc>https://equin.ai/website/download</loc></url>\n` +
        `</urlset>\n`,
    );
  });

  test("escapes the origin", () => {
    expect(renderSitemapXml("http://a&b", [page("/website")])).toContain(
      "<loc>http://a&amp;b/website</loc>",
    );
  });
});
