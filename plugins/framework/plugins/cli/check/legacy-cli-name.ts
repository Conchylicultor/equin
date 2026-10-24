import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  CLI_NAME,
  CLI_NAMES,
} from "@plugins/framework/plugins/cli/plugins/cli-name/core";

const RULE = "cli:legacy-cli-name";

/** The CLI's old names: still shims at the repo root, never written. */
const LEGACY_NAMES = CLI_NAMES.filter((name) => name !== CLI_NAME);

/**
 * `./<legacy name>` as a command — not inside a longer path or name
 * (`../<name>-wt`, `/…/<name>/postgres`, `./<name>-notes`).
 */
function legacyInvocation(name: string): RegExp {
  return new RegExp(String.raw`(?<![\w.])\./${name}(?![\w/-])`);
}

/**
 * Agents copy the CLI spelling they read — in a hint, a doc, a generated
 * header, a prompt — so every one of them says `./equin`. The old name keeps
 * working as a shim, which is exactly why a stale mention would never fail on
 * its own: this check is the only thing that notices one.
 *
 * Every tracked text file is in scope, prose included (unlike `grepCode`,
 * which masks comments and strings): a doc is what agents read most.
 */
const legacyCliNameCheck: Check = {
  id: RULE,
  // INPUT-KEYED: a pure function of the `git grep -l` selection, its
  // candidates' content and the exemption manifests — all recorded.
  inputKeyed: true,
  description: `no tracked file names the CLI by its old name (\`./${LEGACY_NAMES.join("`, `./")}\`) — agents read and copy it; write \`./${CLI_NAME}\``,
  exemptable: {
    [RULE]: `writes the CLI's old name (\`./${LEGACY_NAMES.join("`, `./")}\`) on purpose — e.g. a test that the legacy shim is still recognised`,
  },
  async run(ctx) {
    const exempt = await ctx.exempt(RULE);
    const offenders: string[] = [];
    for (const name of LEGACY_NAMES) {
      const pattern = legacyInvocation(name);
      const candidates = await listCandidateSources({
        grepArg: `./${name}`,
        fixed: true,
        pathspecs: ["."],
      });
      for (const { rel, src } of candidates) {
        const lines = src.split("\n");
        const hits = lines.flatMap((text, i) =>
          pattern.test(text) ? [`${rel}:${i + 1}:${text.trim()}`] : [],
        );
        if (hits.length === 0 || exempt.skips(rel)) continue;
        offenders.push(...hits);
      }
    }

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} mention(s) of the CLI's old name:\n    ${offenders.join("\n    ")}`,
      hint:
        `Write \`./${CLI_NAME}\` — in docs, comments, hints and prompts alike. ` +
        "Code that runs or names the CLI uses `CLI_NAME` (and a matcher over command text `CLI_NAME_PATTERN`) from `@plugins/framework/plugins/cli/plugins/cli-name/core`, never a literal. " +
        `A file that must spell the old name (a test of the legacy shim) declares a \`${RULE}\` exemption in its plugin's \`exempt/index.ts\`.`,
    };
  },
};

export default legacyCliNameCheck;
