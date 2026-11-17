import { describe, expect, test } from "bun:test";
import {
  isLocalAppUrl,
  isPublicSiteUrl,
  localAppPortFor,
  localAppUrl,
  localSiteUrl,
  PUBLIC_SITE_ORIGIN,
  publicSitePageUrl,
  publicSiteUrl,
} from "./site";

const local = localAppUrl(8700);

describe("the site's two origins", () => {
  test("a published page opens locally under the website's base path", () => {
    expect(
      localSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/guide?x=1#top`), 8700),
    ).toBe(`${local}/about/guide?x=1#top`);
    expect(localSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/`), 8700)).toBe(
      `${local}/about`,
    );
  });

  test("a local site page opens on equin.ai without the base path", () => {
    expect(publicSiteUrl(new URL(`${local}/about/apps`))).toBe(
      `${PUBLIC_SITE_ORIGIN}/apps`,
    );
    expect(publicSiteUrl(new URL(`${local}/about`))).toBe(
      `${PUBLIC_SITE_ORIGIN}/`,
    );
  });

  test("a website page's published URL", () => {
    expect(publicSitePageUrl("/about/guide")).toBe(
      `${PUBLIC_SITE_ORIGIN}/guide`,
    );
    expect(publicSitePageUrl("/about?x=1")).toBe(`${PUBLIC_SITE_ORIGIN}/?x=1`);
  });

  test("any page of a local instance opens on equin.ai", () => {
    expect(publicSiteUrl(new URL(`${local}/agents`))).toBe(
      `${PUBLIC_SITE_ORIGIN}/`,
    );
    expect(
      publicSiteUrl(new URL("http://att-x.localhost:9000/about/guide")),
    ).toBe(`${PUBLIC_SITE_ORIGIN}/guide`);
    expect(publicSiteUrl(new URL(`${local}/aboutx`))).toBe(
      `${PUBLIC_SITE_ORIGIN}/`,
    );
  });

  test("only a local gateway namespace is a local instance", () => {
    expect(isLocalAppUrl(new URL(`${local}/agents`))).toBe(true);
    expect(isLocalAppUrl(new URL("http://att-x.localhost:8701/"))).toBe(true);
    // An install that has not moved off the old port yet.
    expect(isLocalAppUrl(new URL("http://att-x.localhost:9000/"))).toBe(true);
    expect(isLocalAppUrl(new URL("http://localhost:8700/"))).toBe(false);
    expect(isLocalAppUrl(new URL("http://equin.localhost:8710/"))).toBe(false);
    expect(isLocalAppUrl(new URL("http://equin.localhost:3000/"))).toBe(false);
    expect(isLocalAppUrl(new URL(`${PUBLIC_SITE_ORIGIN}/about`))).toBe(false);
    expect(() => publicSiteUrl(new URL("https://example.com/"))).toThrow();
  });

  test("a local page names its own port; equin.ai names the default", () => {
    expect(localAppPortFor(new URL("http://equin.localhost:8703/about"))).toBe(
      8703,
    );
    expect(localAppPortFor(new URL(`${PUBLIC_SITE_ORIGIN}/download`))).toBe(
      8700,
    );
  });

  test("only equin.ai is the published site", () => {
    expect(isPublicSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/`))).toBe(true);
    expect(isPublicSiteUrl(new URL("http://equin.ai/about"))).toBe(false);
    expect(isPublicSiteUrl(new URL("https://www.equin.ai/about"))).toBe(false);
    expect(() =>
      localSiteUrl(new URL("https://example.com/about"), 8700),
    ).toThrow();
  });
});
