import { z } from "zod";
import type { ToolCall } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

/** WebSearch's input, as its card draws it. */
export const WebSearchInputSchema = z.looseObject({
  query: z.string(),
  mode: z.string().optional(),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional(),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

const LinksSchema = z.array(z.object({ title: z.string(), url: z.string() }));

export interface SearchLink {
  title: string;
  url: string;
}

/** The links of one site, in the order the search returned them. */
export interface SearchSite {
  host: string;
  links: SearchLink[];
}

/** Which sites the search was confined to (`only`) or kept away from. */
export interface SearchScope {
  kind: "only" | "excluded";
  domains: string[];
}

export interface WebSearch {
  query: string;
  /** `extended` / `standard`; absent when the call left it to the harness. */
  mode?: string;
  scope?: SearchScope;
  /** Undefined while the call is in flight or when it failed. */
  outcome?: { summary: string; links: SearchLink[]; sites: SearchSite[] };
}

const HEADER = /^Web search results for query: .*$/m;
const LINKS_LINE = /^Links: (\[.*\])$/gm;
// The harness appends an instruction to the model; it is not part of the answer.
const REMINDER = /\n*REMINDER: You MUST include the sources[\s\S]*$/;

export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, "") : url;
}

/** Group links by site, busiest site first (ties keep first-seen order). */
export function groupBySite(links: SearchLink[]): SearchSite[] {
  const byHost = new Map<string, SearchLink[]>();
  for (const link of links) {
    const host = hostOf(link.url);
    const group = byHost.get(host);
    if (group) group.push(link);
    else byHost.set(host, [link]);
  }
  return [...byHost]
    .map(([host, ls]) => ({ host, links: ls }))
    .sort((a, b) => b.links.length - a.links.length);
}

/**
 * Split a WebSearch result into the model-written summary and the links.
 *
 * The result is text: a header naming the query, one `Links: [...]` JSON line
 * per search round (an extended search runs several, which may repeat URLs),
 * the summary, and a trailing reminder to the model.
 */
export function parseWebSearchResult(content: string): {
  summary: string;
  links: SearchLink[];
} {
  const links: SearchLink[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(LINKS_LINE)) {
    const parsed = LinksSchema.parse(JSON.parse(m[1]!));
    for (const link of parsed) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
    }
  }
  const summary = content
    .replace(HEADER, "")
    .replace(LINKS_LINE, "")
    .replace(REMINDER, "")
    .trim();
  return { summary, links };
}

export function readWebSearch(
  event: ToolCall,
  input: WebSearchInput,
): WebSearch {
  const scope: SearchScope | undefined = input.allowed_domains?.length
    ? { kind: "only", domains: input.allowed_domains }
    : input.blocked_domains?.length
      ? { kind: "excluded", domains: input.blocked_domains }
      : undefined;
  const result = event.result;
  const outcome =
    result && !result.isError
      ? (() => {
          const { summary, links } = parseWebSearchResult(result.content);
          return { summary, links, sites: groupBySite(links) };
        })()
      : undefined;
  return { query: input.query.trim(), mode: input.mode, scope, outcome };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
