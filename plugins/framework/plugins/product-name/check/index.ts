import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
// Own-plugin, so relative (same shape as `namespace/check`).
import {
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
} from "../core/internal/product-name";
import legacyIdChecks from "./legacy-id";

const RULE = "product-name:legacy";

/**
 * The legacy name as a WORD, capitalised: the product name in prose and in
 * strings. Not a lowercase identifier, not part of a camelCase one, and not a
 * commit-trailer key (`<Name>-Conversation:`) — those are
 * `product-name:legacy-id`'s (`./legacy-id.ts`).
 */
function legacyWord(name: string): RegExp {
  return new RegExp(String.raw`(?<![\w-])${name}(?![\w]|-[A-Z])`);
}

/**
 * People and agents read the product's name in titles, messages, docs and tool
 * descriptions, and copy what they read — so every one of them says
 * `PRODUCT_NAME`. Nothing breaks when an old mention survives, which is exactly
 * why this check is the only thing that would notice one.
 *
 * Every tracked text file is in scope, prose included.
 */
const legacyProductNameCheck: Check = {
  id: RULE,
  // INPUT-KEYED: a pure function of the `git grep -l` selection, its
  // candidates' content and the exemption manifests — all recorded.
  inputKeyed: true,
  description: `no tracked file calls the product by its old name (${LEGACY_PRODUCT_NAMES.join(", ")}) — write \`${PRODUCT_NAME}\``,
  exemptable: {
    [RULE]: `writes the product's old name (${LEGACY_PRODUCT_NAMES.join(", ")}) on purpose — e.g. a migration that finds something stored under it`,
  },
  async run(ctx) {
    const exempt = await ctx.exempt(RULE);
    const offenders: string[] = [];
    for (const name of LEGACY_PRODUCT_NAMES) {
      const pattern = legacyWord(name);
      const candidates = await listCandidateSources({
        grepArg: name,
        fixed: true,
        pathspecs: ["."],
      });
      for (const { rel, src } of candidates) {
        if (exempt.skips(rel)) continue;
        src.split("\n").forEach((text, i) => {
          if (pattern.test(text)) {
            offenders.push(`${rel}:${i + 1}:${text.trim()}`);
          }
        });
      }
    }

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} mention(s) of the product's old name:\n    ${offenders.join("\n    ")}`,
      hint:
        `Write \`${PRODUCT_NAME}\` — always lowercase, even at the start of a sentence or in a title — in docs, comments, messages and tool descriptions alike. ` +
        "Code that puts the name in a value (a title, a User-Agent, a folder name) uses `PRODUCT_NAME` from `@plugins/framework/plugins/product-name/core`, never a literal. " +
        `A file that must spell the old name (a migration that finds something stored under it) declares a \`${RULE}\` exemption in its plugin's \`exempt/index.ts\`.`,
    };
  },
};

export default [legacyProductNameCheck, ...legacyIdChecks];
