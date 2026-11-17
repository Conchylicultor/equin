import { describe, expect, test } from "bun:test";
import {
  isLocalAppUrl,
  isPublicSiteUrl,
  LOCAL_APP_URL,
  localSiteUrl,
  PUBLIC_SITE_ORIGIN,
  publicSitePageUrl,
  publicSiteUrl,
} from "./site";

const local = new URL(LOCAL_APP_URL).origin;

describe("the site's two origins", () => {
  test("a published page opens locally under the website's base path", () => {
    expect(localSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/guide?x=1#top`))).toBe(
      `${local}/about/guide?x=1#top`,
    );
    expect(localSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/`))).toBe(
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
    expect(isLocalAppUrl(new URL("http://att-x.localhost:9000/"))).toBe(true);
    expect(isLocalAppUrl(new URL("http://localhost:9000/"))).toBe(false);
    expect(isLocalAppUrl(new URL("http://equin.localhost:3000/"))).toBe(false);
    expect(isLocalAppUrl(new URL(`${PUBLIC_SITE_ORIGIN}/about`))).toBe(false);
    expect(() => publicSiteUrl(new URL("https://example.com/"))).toThrow();
  });

  test("only equin.ai is the published site", () => {
    expect(isPublicSiteUrl(new URL(`${PUBLIC_SITE_ORIGIN}/`))).toBe(true);
    expect(isPublicSiteUrl(new URL("http://equin.ai/about"))).toBe(false);
    expect(isPublicSiteUrl(new URL("https://www.equin.ai/about"))).toBe(false);
    expect(() => localSiteUrl(new URL("https://example.com/about"))).toThrow();
  });
});
