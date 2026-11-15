// The one rule every demo script checks "nothing left the scope" by: each
// page-origin `/api` request the page sends is ATTRIBUTED to who issued it —
// the page's own chrome, or code inside the demo's scope — and only the
// second is a leak. The demo runs in the page's document, so a request's
// origin cannot say who sent it; its issuer mark (`networking`'s request
// issuer, a header the server ignores) or, for an element's load, the element
// holding its URL can. See this plugin's CLAUDE.md, "Did the demo leak?".
import type { Page, Request } from "playwright";
import {
  parseRequestIssuer,
  REQUEST_ISSUER_HEADER,
} from "@plugins/primitives/plugins/networking/core";
import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import { qualifyThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  pathUrl,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * The page-origin `/api` routes that are the page's telemetry (D3, the
 * `networking/no-page-transport` sanctioned importers): the page's collectors
 * report what happens in the document, the demo included, to the page's own
 * server — by design, whoever raised it.
 */
const TELEMETRY: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  // A site page's error reports (its report channel, the standalone website).
  /^\/api\/site-reports$/,
  /^\/api\/health(\/ready)?$/,
];

/** Request kinds an element issues (its URL held by a `src`, `href`, `poster`…). */
const ELEMENT_LOADS = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
  "document",
]);

/**
 * A `<use href>` drawing from the PAGE's glyph sheet (a Material or Lucide
 * glyph without a scope store's `rs<n>-` prefix): never inside the embed —
 * the scope's icons are drawn from its own server (`ScopeIconSymbols`).
 */
const PAGE_GLYPH_ID = /^#(msr-|lucide-)/;

/** Where an element-held URL sits: inside the demo's DOM, outside it, or nowhere. */
type Holder = "scope" | "page" | "none";

/** One page-origin `/api` request, attributed. */
type Verdict =
  | { kind: "telemetry"; line: string }
  | { kind: "chrome"; line: string; by: string }
  | { kind: "leak"; line: string; by: string }
  | { kind: "unattributed"; line: string; why: string };

export interface PageOriginRequests {
  /** Every http(s) request to another origin, as `host/path` (the scripts check the hosts). */
  readonly offOrigin: readonly { host: string; path: string }[];
  /** The leaks seen so far, once every pending attribution settled. */
  leaks(): Promise<string[]>;
  /**
   * Stop watching and assert the rule: no request the demo's scope issued
   * reached the page's server, every request is attributed, and no icon inside
   * the embed draws from the page's glyph sheet. Call while the demo shows.
   */
  finish(): Promise<void>;
}

/** The DOM marker of what the demo's scope renders: its qualified theme scopes. */
const SCOPE_THEME_PREFIX = qualifyThemeScope(workspaceDemo.host.id, "");

/**
 * Watch every request the page sends from now on and attribute each
 * page-origin `/api` one (see the file header). The page's own chrome — its
 * Full screen and Reset buttons, the video player, an icon it draws — is
 * logged as such, never failed; a request from inside the scope fails as a
 * real leak; a request nothing attributes fails as unattributed.
 */
export function watchPageOrigin(page: Page, r: Report): PageOriginRequests {
  // The deploy's origin, so a watch may start before the page loads and
  // outlive its reloads and visits elsewhere.
  const pageOrigin = new URL(pathUrl("/")).origin;
  const offOrigin: { host: string; path: string }[] = [];
  const pending: Promise<Verdict>[] = [];

  const attribute = async (req: Request, url: URL): Promise<Verdict> => {
    const line = `${req.method()} ${url.pathname}${url.search}`;
    if (TELEMETRY.some((re) => re.test(url.pathname)))
      return { kind: "telemetry", line };
    const mark = req.headers()[REQUEST_ISSUER_HEADER.toLowerCase()];
    if (mark !== undefined) {
      const issuer = parseRequestIssuer(mark);
      if (issuer === null)
        return {
          kind: "unattributed",
          line,
          why: `an unknown issuer mark "${mark}"`,
        };
      return issuer === "page"
        ? { kind: "chrome", line, by: "issued by the page's transport" }
        : {
            kind: "leak",
            line,
            by: `issued by ${issuer} through the page's transport`,
          };
    }
    if (!ELEMENT_LOADS.has(req.resourceType()))
      return {
        kind: "unattributed",
        line,
        why: `a ${req.resourceType()} request with no ${REQUEST_ISSUER_HEADER} mark`,
      };
    const holder = await elementHolder(page, url).catch((err: unknown) => {
      if (err instanceof Error) return err;
      throw err;
    });
    if (holder instanceof Error)
      return {
        kind: "unattributed",
        line,
        why: `its element could not be looked up (${holder.message.split("\n")[0]})`,
      };
    if (holder === "scope")
      return {
        kind: "leak",
        line,
        by: `a ${req.resourceType()} load of an element inside the demo`,
      };
    if (holder === "page")
      return {
        kind: "chrome",
        line,
        by: `a ${req.resourceType()} load of the page's own element`,
      };
    return {
      kind: "unattributed",
      line,
      why: `a ${req.resourceType()} load no element's src / href / poster holds`,
    };
  };

  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin !== pageOrigin) {
      offOrigin.push({ host: url.host, path: url.pathname });
      return;
    }
    if (url.pathname.startsWith("/api/")) pending.push(attribute(req, url));
  };
  page.on("request", onRequest);

  const settled = () => Promise.all(pending);
  return {
    offOrigin,
    async leaks() {
      return (await settled())
        .filter((v) => v.kind === "leak")
        .map((v) => `${v.line} — ${v.by}`);
    },
    async finish() {
      page.off("request", onRequest);
      const verdicts = await settled();
      const of = <K extends Verdict["kind"]>(kind: K) =>
        verdicts.filter(
          (v): v is Extract<Verdict, { kind: K }> => v.kind === kind,
        );
      const telemetry = of("telemetry");
      const chrome = of("chrome");
      const leaks = of("leak");
      const unattributed = of("unattributed");
      const distinct = (lines: string[]) => [...new Set(lines)];
      r.note(
        `page-origin /api: ${telemetry.length} telemetry, ${chrome.length} the page's own chrome (not a leak), ${leaks.length} from the demo, ${unattributed.length} unattributed`,
      );
      for (const line of distinct(chrome.map((v) => `${v.line} (${v.by})`)))
        r.note(`  the page's own chrome, not a leak: ${line}`);
      r.ok(
        "no request from inside the demo reached the page's server",
        leaks.length === 0,
        leaks.length === 0
          ? "none"
          : `REAL LEAK — code inside the demo's scope reached the page's server instead of the demo's worker:\n  ${distinct(leaks.map((v) => `${v.line} — ${v.by}`)).join("\n  ")}`,
      );
      r.ok(
        "every page-origin /api request is attributed (the page's or the demo's)",
        unattributed.length === 0,
        unattributed.length === 0
          ? "all attributed"
          : `NOT a confirmed leak — but who sent these is unknown, so they cannot be cleared either. Make the channel that issued them name its issuer (${REQUEST_ISSUER_HEADER}, primitives/networking's request issuer); never allow-list them here:\n  ${distinct(unattributed.map((v) => `${v.line} — ${v.why}`)).join("\n  ")}`,
      );
      const embeds = await page.locator("[data-app-embed]").count();
      const pageGlyphs =
        embeds === 0
          ? null
          : await page
              .locator("[data-app-embed]")
              .first()
              .evaluate(
                (root, pageGlyph) =>
                  [...root.querySelectorAll("use")]
                    .map((u) => u.getAttribute("href") ?? "")
                    .filter((href) => new RegExp(pageGlyph).test(href)),
                PAGE_GLYPH_ID.source,
              );
      r.ok(
        "no icon inside the embed draws a glyph from the page's sheet",
        pageGlyphs !== null && pageGlyphs.length === 0,
        pageGlyphs === null
          ? "no embed on the page to check — finish() while the demo shows"
          : pageGlyphs.length === 0
            ? "none"
            : `REAL LEAK — the demo's icons are drawn from the page's glyph store, read from the page's server: ${distinct(pageGlyphs).join(", ")}`,
      );
    },
  };
}

/**
 * Where the element holding `url` (as its `src`, `currentSrc`, `href`,
 * `poster`) renders: inside the demo (the embed, or anything its scope's
 * theme boundaries paint — a portalled dialog included), outside it, or
 * nowhere — when no element holds it.
 */
async function elementHolder(page: Page, url: URL): Promise<Holder> {
  return page.evaluate(
    ({ target, scopePrefix }) => {
      const matches = (value: string | null | undefined): boolean => {
        if (value === null || value === undefined || value === "") return false;
        const u = new URL(value, document.baseURI);
        return u.pathname + u.search === target;
      };
      const holders = [
        ...document.querySelectorAll(
          "[src], [href], [poster], video, audio, img",
        ),
      ].filter((el) => {
        const media = el as HTMLMediaElement & HTMLImageElement;
        return (
          matches(el.getAttribute("src")) ||
          matches(el.getAttribute("href")) ||
          matches(el.getAttribute("poster")) ||
          matches(media.currentSrc)
        );
      });
      if (holders.length === 0) return "none" as const;
      const inScope = (el: Element): boolean =>
        el.closest("[data-app-embed]") !== null ||
        el.closest(`[data-theme-scope^="${scopePrefix}"]`) !== null;
      return holders.some(inScope) ? ("scope" as const) : ("page" as const);
    },
    { target: url.pathname + url.search, scopePrefix: SCOPE_THEME_PREFIX },
  );
}
