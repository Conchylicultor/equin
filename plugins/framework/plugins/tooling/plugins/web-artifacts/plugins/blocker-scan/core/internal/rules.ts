// Content-blocker rules, as Chrome's declarativeNetRequest (DNR) spells them —
// the form uBlock Origin Lite ships EasyList, EasyPrivacy and uBlock filters
// in — and the one question asked of them: would this rule cancel (block or
// redirect) a request for this URL of ours?
//
// Only GENERIC rules are kept: ones that name no domain the request goes to
// or comes from. A rule naming a domain cannot match our origin (equin.ai,
// localhost), so the generic ones are the whole risk, and they are a few
// thousand rules rather than tens of thousands.

import { z } from "zod";

const ResourceTypeSchema = z.string();

/** One DNR rule, as much of it as the question needs (other keys pass through). */
export const DnrRuleSchema = z.object({
  id: z.number().int(),
  action: z.object({ type: z.string() }).passthrough(),
  condition: z
    .object({
      urlFilter: z.string().optional(),
      regexFilter: z.string().optional(),
      isUrlFilterCaseSensitive: z.boolean().optional(),
      requestDomains: z.array(z.string()).optional(),
      initiatorDomains: z.array(z.string()).optional(),
      excludedRequestDomains: z.array(z.string()).optional(),
      excludedInitiatorDomains: z.array(z.string()).optional(),
      domainType: z.enum(["firstParty", "thirdParty"]).optional(),
      resourceTypes: z.array(ResourceTypeSchema).optional(),
      excludedResourceTypes: z.array(ResourceTypeSchema).optional(),
      requestMethods: z.array(z.string()).optional(),
      excludedRequestMethods: z.array(z.string()).optional(),
    })
    .passthrough(),
});
export type DnrRule = z.infer<typeof DnrRuleSchema>;

/** One ruleset a blocker turns on by default, with its rules. */
export const RulesetSchema = z.object({
  id: z.string(),
  name: z.string(),
  rules: z.array(DnrRuleSchema),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

/** The derived dataset the blocker-rulesets dependency installs. */
export const DefaultRulesetsSchema = z.object({
  /** Where the rules come from, for people: the blocker and its release. */
  source: z.string(),
  rulesets: z.array(RulesetSchema),
});
export type DefaultRulesets = z.infer<typeof DefaultRulesetsSchema>;

/** The actions that keep a request from loading what it asked for. */
const CANCELLING_ACTIONS = new Set(["block", "redirect"]);

/**
 * The hosts our URLs are served from — the public site and every local
 * namespace. A rule excluding one of them does not apply to us.
 */
export const SERVED_HOSTS = ["equin.ai", "localhost"] as const;

function coversServedHost(domains: readonly string[] | undefined): boolean {
  return (domains ?? []).some((d) =>
    SERVED_HOSTS.some((h) => h === d || h.endsWith(`.${d}`)),
  );
}

/** A generic rule, compiled for matching. */
export interface CompiledRule {
  ruleset: string;
  id: number;
  /** The filter as the list writes it (`urlFilter`, or `/regex/`). */
  filter: string;
  /** Lowercased literal every match must contain (a cheap prefilter); "" when none. */
  needle: string;
  caseSensitive: boolean;
  re: RegExp;
  resourceTypes: ReadonlySet<string> | null;
  excludedResourceTypes: ReadonlySet<string> | null;
}

/** Why a rule was set aside as one this scan cannot compile. */
export interface UncompiledRule {
  ruleset: string;
  id: number;
  filter: string;
  error: string;
}

const SEPARATOR = "(?:[^A-Za-z0-9_\\-.%]|$)";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * A DNR `urlFilter` as a RegExp source: `*` any run, `^` a separator (not a
 * letter, digit or `_-.%`, or the end), a leading `|` anchors the start, a
 * trailing `|` the end, a leading `||` a domain (unused here: generic rules
 * have none). Unanchored otherwise.
 */
export function urlFilterSource(filter: string): string {
  let f = filter;
  let prefix = "";
  let suffix = "";
  if (f.startsWith("||")) {
    prefix = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
    f = f.slice(2);
  } else if (f.startsWith("|")) {
    prefix = "^";
    f = f.slice(1);
  }
  if (f.endsWith("|")) {
    suffix = "$";
    f = f.slice(0, -1);
  }
  let body = "";
  for (const ch of f) {
    if (ch === "*") body += ".*";
    else if (ch === "^") body += SEPARATOR;
    else body += escapeRe(ch);
  }
  return prefix + body + suffix;
}

/** The longest run of plain characters in a urlFilter: every match contains it. */
export function urlFilterNeedle(filter: string): string {
  const runs = filter.replace(/^\|\|?|\|$/g, "").split(/[*^]/);
  return runs.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/**
 * Whether a rule is generic and can cancel a first-party GET of ours: a
 * block or redirect, naming no request or initiator domain and no `||`
 * host, not third-party only, not excluding our hosts, and not limited to
 * methods other than GET.
 */
export function isGenericCancellingRule(rule: DnrRule): boolean {
  const c = rule.condition;
  if (!CANCELLING_ACTIONS.has(rule.action.type)) return false;
  if (c.urlFilter === undefined && c.regexFilter === undefined) return false;
  if (c.requestDomains !== undefined || c.initiatorDomains !== undefined)
    return false;
  if (c.urlFilter?.startsWith("||") === true) return false;
  if (c.domainType === "thirdParty") return false;
  if (
    coversServedHost(c.excludedRequestDomains) ||
    coversServedHost(c.excludedInitiatorDomains)
  )
    return false;
  if (c.requestMethods !== undefined && !c.requestMethods.includes("get"))
    return false;
  if (c.excludedRequestMethods?.includes("get") === true) return false;
  return true;
}

/** Every generic cancelling rule of `rulesets`, compiled; the ones JS cannot compile set aside, named. */
export function compileGenericRules(rulesets: readonly Ruleset[]): {
  rules: CompiledRule[];
  uncompiled: UncompiledRule[];
} {
  const rules: CompiledRule[] = [];
  const uncompiled: UncompiledRule[] = [];
  for (const set of rulesets) {
    for (const rule of set.rules) {
      if (!isGenericCancellingRule(rule)) continue;
      const c = rule.condition;
      const caseSensitive = c.isUrlFilterCaseSensitive === true;
      const filter =
        c.urlFilter !== undefined ? c.urlFilter : `/${c.regexFilter!}/`;
      let re: RegExp;
      try {
        re = new RegExp(
          c.urlFilter !== undefined
            ? urlFilterSource(c.urlFilter)
            : c.regexFilter!,
          caseSensitive ? "" : "i",
        );
      } catch (err) {
        // RE2 (what DNR compiles a regexFilter with) and JS disagree on a few
        // constructs; the rule is reported as unchecked, never dropped silently.
        uncompiled.push({
          ruleset: set.id,
          id: rule.id,
          filter,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      rules.push({
        ruleset: set.id,
        id: rule.id,
        filter,
        needle:
          c.urlFilter !== undefined
            ? urlFilterNeedle(c.urlFilter).toLowerCase()
            : "",
        caseSensitive,
        re,
        resourceTypes:
          c.resourceTypes === undefined ? null : new Set(c.resourceTypes),
        excludedResourceTypes:
          c.excludedResourceTypes === undefined
            ? null
            : new Set(c.excludedResourceTypes),
      });
    }
  }
  return { rules, uncompiled };
}

/**
 * The DNR resource types a request for this path can be made as. A module is
 * fetched as `script` (a page or worker import) or by `fetch` (a prefetch, a
 * worker boot probe); anything we do not recognise counts as every fetchable
 * type, so an unknown extension is checked against more rules, not fewer.
 */
export function resourceTypesOf(path: string): readonly string[] {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (["js", "mjs", "cjs"].includes(ext))
    return ["script", "xmlhttprequest", "other"];
  if (ext === "css") return ["stylesheet", "xmlhttprequest", "other"];
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"].includes(ext))
    return ["image", "xmlhttprequest", "other"];
  if (["woff", "woff2", "ttf", "otf"].includes(ext))
    return ["font", "xmlhttprequest", "other"];
  if (["mp3", "mp4", "webm", "ogg", "wav", "m4a"].includes(ext))
    return ["media", "xmlhttprequest", "other"];
  if (ext === "html") return ["main_frame", "sub_frame", "xmlhttprequest"];
  return ["xmlhttprequest", "other", "script", "image", "font", "media"];
}

function appliesToTypes(rule: CompiledRule, types: readonly string[]): boolean {
  return types.some(
    (t) =>
      (rule.resourceTypes === null
        ? t !== "main_frame"
        : rule.resourceTypes.has(t)) &&
      (rule.excludedResourceTypes === null ||
        !rule.excludedResourceTypes.has(t)),
  );
}

/** The rules that would cancel a request for `url` (served at `path`). */
export function matchingRules(
  rules: readonly CompiledRule[],
  url: string,
  path: string,
): CompiledRule[] {
  const lower = url.toLowerCase();
  const types = resourceTypesOf(path);
  return rules.filter(
    (r) =>
      (r.needle === "" || lower.includes(r.needle)) &&
      r.re.test(url) &&
      appliesToTypes(r, types),
  );
}
