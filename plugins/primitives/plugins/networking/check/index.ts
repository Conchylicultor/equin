import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";

const RULE = "networking/no-page-transport";

// An eslint directive comment (`// eslint-disable-next-line …`,
// `/* eslint-disable … */`, `// eslint-disable-line …`) naming the rule.
const DIRECTIVE_RE =
  /\/[/*]\s*eslint-disable(?:-next-line|-line)?\b[^\n]*networking\/no-page-transport/g;

/**
 * `networking/no-page-transport` has no inline opt-out. Importing the page's
 * transport is sanctioned only by a `kind: "sanctioned"` entry in the
 * importer's own `exempt/index.ts`: visible in `./singularity exempt list`,
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
      grepArg: RULE,
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
      hint: `Delete the directive. A module that must reach the page's own server declares a \`kind: "sanctioned"\` entry for \`${RULE}\` (with its reason) in its plugin's exempt/index.ts; anything else resolves its transport with useTransport() / useFetchEndpoint().`,
    };
  },
};

export default check;
