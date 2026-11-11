import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  listCandidateSources,
  parsedTsSource,
  type SourceText,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { websitePaneIdentity } from "../core/internal/page";

// Lazily loaded so the check runner's "load every check" burst pays nothing.
let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/** Where a page name was written. */
interface Site {
  name: string;
  file: string;
  line: number;
}

/** A `defineWebsitePage` declaration: its binding and its literal path. */
interface Declaration extends Site {
  path: string | null;
}

/**
 * A website pane — `Pane.define({ app: websiteApp, … })` — named by the page
 * its `title: <page>.title` reads. `route` is null when the route is not an
 * inline `defineRoute({ id: "…", segment: "…" })` of literals; `appIndex` null
 * when it is not a boolean literal.
 */
interface PaneSite extends Site {
  route: { id: string; segment: string } | null;
  appIndex: boolean | null;
}

/** What one source declares and uses. */
export interface PageSites {
  declared: Declaration[];
  paned: PaneSite[];
  served: Site[];
  /** A pane / server site that names its page by no plain identifier. */
  opaque: Site[];
}

function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isCallTo(ts: typeof TS, node: TS.CallExpression, name: string) {
  const callee = node.expression;
  if (name.includes(".")) {
    const [object, property] = name.split(".");
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === object &&
      callee.name.text === property
    );
  }
  return ts.isIdentifier(callee) && callee.text === name;
}

/** The `key: value` initializers of a call's object-literal argument. */
function propsOf(
  ts: typeof TS,
  call: TS.CallExpression,
): Map<string, TS.Expression> {
  const out = new Map<string, TS.Expression>();
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return out;
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      out.set(prop.name.text, prop.initializer);
    }
  }
  return out;
}

function literalOf(ts: typeof TS, node: TS.Expression | undefined) {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function pathOf(ts: typeof TS, call: TS.CallExpression): string | null {
  return literalOf(ts, propsOf(ts, call).get("path"));
}

/** An inline `defineRoute({ id: "…", segment: "…" })`'s literals, else null. */
function routeOf(ts: typeof TS, node: TS.Expression | undefined) {
  if (
    node === undefined ||
    !ts.isCallExpression(node) ||
    !isCallTo(ts, node, "defineRoute")
  ) {
    return null;
  }
  const props = propsOf(ts, node);
  const id = literalOf(ts, props.get("id"));
  const segment = literalOf(ts, props.get("segment"));
  return id === null || segment === null ? null : { id, segment };
}

/** `appIndex:` as written: absent is false, a non-literal null. */
function appIndexOf(ts: typeof TS, node: TS.Expression | undefined) {
  if (node === undefined) return false;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/**
 * The page sites of one parsed source:
 *
 * - declared — `const <name> = defineWebsitePage({ path: "…", … })`;
 * - paned — `Pane.define({ app: websiteApp, title: <name>.title, … })`
 *   (every pane of the website app is a page's);
 * - served — `WebsitePages.Page(<name>)` (the server collection).
 *
 * Pages are matched by binding name, which the check holds unique.
 */
export function pageSitesOf(ts: typeof TS, sf: TS.SourceFile): PageSites {
  const out: PageSites = { declared: [], paned: [], served: [], opaque: [] };
  const file = sf.fileName;
  const visit = (node: TS.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isCallTo(ts, node.initializer, "defineWebsitePage")
    ) {
      out.declared.push({
        name: node.name.text,
        file,
        line: lineOf(sf, node),
        path: pathOf(ts, node.initializer),
      });
    } else if (ts.isCallExpression(node) && isCallTo(ts, node, "Pane.define")) {
      const props = propsOf(ts, node);
      const app = props.get("app");
      if (
        app !== undefined &&
        ts.isIdentifier(app) &&
        app.text === "websiteApp"
      ) {
        const title = props.get("title");
        const line = lineOf(sf, node);
        if (
          title !== undefined &&
          ts.isPropertyAccessExpression(title) &&
          ts.isIdentifier(title.expression) &&
          title.name.text === "title"
        ) {
          out.paned.push({
            name: title.expression.text,
            file,
            line,
            route: routeOf(ts, props.get("route")),
            appIndex: appIndexOf(ts, props.get("appIndex")),
          });
        } else {
          out.opaque.push({
            name: `title: ${title?.getText(sf) ?? "(none)"}`,
            file,
            line,
          });
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      isCallTo(ts, node, "WebsitePages.Page")
    ) {
      const arg = node.arguments[0];
      const site = {
        name: arg?.getText(sf) ?? "",
        file,
        line: lineOf(sf, node),
      };
      if (arg !== undefined && ts.isIdentifier(arg)) out.served.push(site);
      else out.opaque.push(site);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const where = (s: Site) => `${s.file}:${s.line}`;

/**
 * Every problem with the website's page declarations, given every page site in
 * the repo: a page with no pane, a page missing from the server collection, a
 * pane or a server entry naming no declared page, a name or path declared twice,
 * a path that is not a literal, a pane whose route is not the one its page's
 * path gives (`websitePaneIdentity`). Empty when they agree.
 */
export function pageProblems(sites: readonly PageSites[]): string[] {
  const declared = sites.flatMap((s) => s.declared);
  const paned = sites.flatMap((s) => s.paned);
  const served = sites.flatMap((s) => s.served);
  const problems: string[] = [];

  for (const site of sites.flatMap((s) => s.opaque)) {
    problems.push(
      `${where(site)}: \`${site.name}\` — name the page by its own binding (an identifier imported from its plugin's core: \`WebsitePages.Page(page)\`, a website pane's \`title: page.title\`), so the check can match it`,
    );
  }

  const byName = new Map<string, Declaration>();
  const byPath = new Map<string, Declaration>();
  for (const d of declared) {
    const prior = byName.get(d.name);
    if (prior) {
      problems.push(
        `page binding \`${d.name}\` declared twice: ${where(prior)} and ${where(d)}`,
      );
    }
    byName.set(d.name, d);
    if (d.path === null) {
      problems.push(
        `${where(d)}: \`${d.name}\` — write its \`path\` as a string literal`,
      );
      continue;
    }
    const samePath = byPath.get(d.path);
    if (samePath) {
      problems.push(
        `path ${d.path} declared twice: \`${samePath.name}\` (${where(samePath)}) and \`${d.name}\` (${where(d)})`,
      );
    }
    byPath.set(d.path, d);
  }

  const names = (list: readonly Site[]) => new Set(list.map((s) => s.name));
  const panedNames = names(paned);
  const servedNames = names(served);
  for (const d of byName.values()) {
    if (!panedNames.has(d.name)) {
      problems.push(
        `${where(d)}: page \`${d.name}\` has no pane — render it with \`Pane.define({ app: websiteApp, title: ${d.name}.title, … })\``,
      );
    }
    if (!servedNames.has(d.name)) {
      problems.push(
        `${where(d)}: page \`${d.name}\` is missing from the sitemap — contribute \`WebsitePages.Page(${d.name})\` in its plugin's server/index.ts`,
      );
    }
  }
  const unknown = (list: readonly Site[], what: string) => {
    const seen = new Map<string, Site>();
    for (const s of list) {
      if (!byName.has(s.name)) {
        problems.push(
          `${where(s)}: ${what} \`${s.name}\`, which no \`defineWebsitePage\` declares`,
        );
      }
      const prior = seen.get(s.name);
      if (prior) {
        problems.push(
          `${what} \`${s.name}\` twice: ${where(prior)} and ${where(s)}`,
        );
      }
      seen.set(s.name, s);
    }
  };
  for (const p of paned) {
    const page = byName.get(p.name);
    if (page === undefined || page.path === null) continue;
    const want = websitePaneIdentity(page.path);
    const route = `defineRoute({ id: "${want.id}", segment: "${want.segment}" })`;
    if (
      p.route === null ||
      p.route.id !== want.id ||
      p.route.segment !== want.segment
    ) {
      problems.push(
        `${where(p)}: the pane of \`${p.name}\` (${page.path}) must declare \`route: ${route}\` inline, as literals`,
      );
    }
    if (p.appIndex !== want.appIndex) {
      problems.push(
        `${where(p)}: the pane of \`${p.name}\` (${page.path}) must ${want.appIndex ? "declare \`appIndex: true\`" : "not declare \`appIndex\`"} — only the landing page (\`/about\`) is the app's index`,
      );
    }
  }
  unknown(paned, "a pane for");
  unknown(served, "a server entry for");
  return problems;
}

/** Parse each source and collect its page sites. */
export async function collectPageSites(
  sources: readonly SourceText[],
): Promise<PageSites[]> {
  const ts = await loadTypescript();
  const out: PageSites[] = [];
  for (const source of sources) {
    out.push(pageSitesOf(ts, await parsedTsSource(ts, source)));
  }
  return out;
}

export const pagesDeclaredCheck: Check = {
  id: "crawlable:pages-declared",
  description:
    "every defineWebsitePage page has exactly one website pane, whose route its path gives, and one server WebsitePages.Page entry (so no page is missing from the sitemap), and nothing else",
  async run() {
    const sources = await listCandidateSources({
      grepArg: String.raw`defineWebsitePage\(|app: websiteApp|WebsitePages\.Page\(`,
      pathspecs: [
        "plugins/**/*.ts",
        "plugins/**/*.tsx",
        ":(exclude)**/*.test.ts",
        ":(exclude)**/*.test.tsx",
        ":(exclude)**/__tests__/**",
      ],
    });
    const problems = pageProblems(await collectPageSites(sources));
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${problems.length} website page problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`,
      hint:
        "A website page is declared once with defineWebsitePage in its plugin's core/, " +
        "rendered by a website pane in its web/ — Pane.define({ route: defineRoute(<its path's id and segment, as literals>), " +
        "app: websiteApp, title: page.title, … }) — and listed in the sitemap with " +
        "WebsitePages.Page(page) in its server/index.ts.",
    };
  },
};
