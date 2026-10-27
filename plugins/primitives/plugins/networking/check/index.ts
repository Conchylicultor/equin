import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";

/** The rules whose only opt-out is a sanctioned manifest entry. */
const RULES = [
  "networking/no-page-transport",
  "networking/no-request-guard-capability",
] as const;
const RULE = RULES.join("` / `");

// An eslint directive comment (`// eslint-disable-next-line …`,
// `/* eslint-disable … */`, `// eslint-disable-line …`) naming either rule.
const DIRECTIVE_RE =
  /\/[/*]\s*eslint-disable(?:-next-line|-line)?\b[^\n]*networking\/no-(?:page-transport|request-guard-capability)\b/g;

/**
 * `networking/no-page-transport` has no inline opt-out, and neither has
 * `networking/no-request-guard-capability` (the request guard's natives are
 * the same kind of key: a way past the subtree's transport). Importing the page's
 * transport is sanctioned only by a `kind: "sanctioned"` entry in the
 * importer's own `exempt/index.ts`: visible in `./equin exempt list`,
 * with a reason — and what the browser-host coverage guard trusts when it
 * reads a page-bound module's endpoints as the page's. An inline disable would
 * be both invisible and a way out of the guard, so it fails here, where no
 * comment can switch it off.
 */
const check: Check = {
  id: "networking:no-inline-page-transport-disable",
  description: `no inline eslint-disable of \`${RULE}\` — a sanctioned importer declares it in its own exempt/index.ts`,
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const hits: string[] = [];
    for (const { rel, src } of await listCandidateSources({
      root: repo.root,
      grepArg: "networking/no-",
      fixed: true,
    })) {
      for (const m of src.matchAll(DIRECTIVE_RE)) {
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line}`);
      }
    }
    if (hits.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${hits.length} inline eslint-disable(s) of \`${RULE}\`:\n${hits.map((h) => `  ${h}`).join("\n")}`,
      hint: `Delete the directive. A module that must reach the page's own server (or the request guard's natives) declares a \`kind: "sanctioned"\` entry for the rule (with its reason) in its plugin's exempt/index.ts; anything else resolves its transport with useTransport() / useFetchEndpoint().`,
    };
  },
};

export default check;
