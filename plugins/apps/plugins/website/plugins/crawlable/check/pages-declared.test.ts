import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { pageProblems, pageSitesOf } from "./pages-declared";

const sites = (files: Record<string, string>) =>
  Object.entries(files).map(([file, src]) =>
    pageSitesOf(
      ts,
      ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true),
    ),
  );

const core = `export const downloadPage = defineWebsitePage({
  path: "/website/download", title: "Download", description: "D.",
});`;
const pane = (
  page: string,
  route = `defineRoute({ id: "website-download", segment: "download" })`,
  extra = "",
) =>
  `Pane.define({ route: ${route}, app: websiteApp,${extra} title: ${page}.title, component: B });`;
const web = `export const downloadPane = ${pane("downloadPage")}`;
const server = `export default { contributions: [WebsitePages.Page(downloadPage)] };`;

describe("crawlable:pages-declared", () => {
  test("a page declared, paned and served passes", () => {
    expect(
      pageProblems(
        sites({
          "a/core/page.ts": core,
          "a/web/panes.tsx": web,
          "a/server/index.ts": server,
        }),
      ),
    ).toEqual([]);
  });

  test("a page with a pane but no server entry is missing from the sitemap", () => {
    const problems = pageProblems(
      sites({ "a/core/page.ts": core, "a/web/panes.tsx": web }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing from the sitemap");
    expect(problems[0]).toContain("WebsitePages.Page(downloadPage)");
  });

  test("a page declared but never given a pane fails", () => {
    const problems = pageProblems(
      sites({ "a/core/page.ts": core, "a/server/index.ts": server }),
    );
    expect(problems).toEqual([
      "a/core/page.ts:1: page `downloadPage` has no pane — render it with `Pane.define({ app: websiteApp, title: downloadPage.title, … })`",
    ]);
  });

  test("a pane or server entry naming no declared page fails", () => {
    const problems = pageProblems(
      sites({ "a/web/panes.tsx": web, "a/server/index.ts": server }),
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("a pane for `downloadPage`");
    expect(problems.join("\n")).toContain("a server entry for `downloadPage`");
  });

  test("a page served twice fails", () => {
    const problems = pageProblems(
      sites({
        "a/core/page.ts": core,
        "a/web/panes.tsx": web,
        "a/server/index.ts": server,
        "b/server/index.ts": server,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("twice");
  });

  test("two pages on one path, or a computed path, fail", () => {
    const other = `export const otherPage = defineWebsitePage({
  path: "/website/download", title: "X", description: "D.",
});
export const computedPage = defineWebsitePage({ path: base + "/x", title: "Y", description: "D." });`;
    const problems = pageProblems(
      sites({
        "a/core/page.ts": core,
        "b/core/page.ts": other,
        "a/web/panes.tsx": `${web}\n${pane("otherPage")}\n${pane("computedPage")}`,
        "a/server/index.ts": `${server}\nWebsitePages.Page(otherPage);\nWebsitePages.Page(computedPage);`,
      }),
    );
    expect(problems.join("\n")).toContain(
      "path /website/download declared twice",
    );
    expect(problems.join("\n")).toContain(
      "`computedPage` — write its `path` as a string literal",
    );
    expect(problems).toHaveLength(2);
  });

  test("a page passed as an expression is refused, not guessed", () => {
    const problems = pageProblems(
      sites({
        "a/core/page.ts": core,
        "a/web/panes.tsx": `${web}\nPane.define({ route: r, app: websiteApp, title: pages.download.title, component: B });`,
        "a/server/index.ts": server,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "`title: pages.download.title` — name the page by its own binding",
    );
  });

  test("a pane of another app is not a website pane", () => {
    expect(
      pageProblems(
        sites({
          "a/core/page.ts": core,
          "a/web/panes.tsx": `${web}\nPane.define({ route: r, app: otherApp, title: "X", component: B });`,
          "a/server/index.ts": server,
        }),
      ),
    ).toEqual([]);
  });

  test("a pane whose route is not the one its page's path gives fails", () => {
    const problems = pageProblems(
      sites({
        "a/core/page.ts": core,
        "a/web/panes.tsx": `export const downloadPane = ${pane(
          "downloadPage",
          `defineRoute({ id: "website-get", segment: "get" })`,
        )}`,
        "a/server/index.ts": server,
      }),
    );
    expect(problems).toEqual([
      'a/web/panes.tsx:1: the pane of `downloadPage` (/website/download) must declare `route: defineRoute({ id: "website-download", segment: "download" })` inline, as literals',
    ]);
  });

  test("a hoisted or computed route is refused, not followed", () => {
    const problems = pageProblems(
      sites({
        "a/core/page.ts": core,
        "a/web/panes.tsx": `export const downloadPane = ${pane("downloadPage", "downloadRoute")}`,
        "a/server/index.ts": server,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("inline, as literals");
  });

  test("only the landing page is the app's index", () => {
    const landing = `export const landingPage = defineWebsitePage({
  path: "/website", title: "equin", description: "D.",
});`;
    const landingRoute = `defineRoute({ id: "website-landing", segment: "" })`;
    const ok = pageProblems(
      sites({
        "a/core/page.ts": landing,
        "a/web/panes.tsx": pane(
          "landingPage",
          landingRoute,
          " appIndex: true,",
        ),
        "a/server/index.ts": "WebsitePages.Page(landingPage);",
      }),
    );
    expect(ok).toEqual([]);
    const missing = pageProblems(
      sites({
        "a/core/page.ts": landing,
        "a/web/panes.tsx": pane("landingPage", landingRoute),
        "a/server/index.ts": "WebsitePages.Page(landingPage);",
      }),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("must declare `appIndex: true`");
    const extra = pageProblems(
      sites({
        "a/core/page.ts": core,
        "a/web/panes.tsx": pane("downloadPage", undefined, " appIndex: true,"),
        "a/server/index.ts": server,
      }),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain("must not declare `appIndex`");
  });
});
