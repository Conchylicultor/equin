import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { PLUGIN_MANIFEST_KEY } from "@plugins/framework/plugins/plugin-id/core";
import { BASE_EXCLUSIONS_ID } from "@plugins/infra/plugins/namespace/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * The plugin id a `plugins/<path>/package.json` belongs to — the inverse of
 * `asFsPath`, which joins a PluginId's segments with the `/plugins/`
 * interstitial. Only ever called for an offending file, and only to spell the
 * replacement in the message, so it does not need the plugin tree (which would
 * cost a full 840-plugin walk to answer a question this check can already read
 * off the path it just found).
 */
function pluginIdFor(relPackageJson: string): string {
  return relPackageJson
    .replace(/^plugins\//, "")
    .replace(/\/package\.json$/, "")
    .split("/plugins/")
    .join(".");
}

const check: Check = {
  id: "no-disabled-flag",
  description: `No plugin package.json may carry \`${PLUGIN_MANIFEST_KEY}.disabled\` — a plugin leaves the app by being negated out of the \`base-exclusions\` composition row, and nothing reads the flag any more`,
  async run() {
    const root = await getWorktreeRoot();

    // Untracked-aware and scan-tree-aware discovery (`listCandidateSources`),
    // narrowed by the literal key text: a package.json declaring the flag must
    // contain the token `"disabled"`, since JSON keys are quoted. A bare
    // `git ls-files` walk would miss a brand-new plugin's not-yet-committed
    // package.json — which is exactly the file an agent produces when adding a
    // plugin, and exactly when it might reach for the flag.
    const candidates = await listCandidateSources({
      root,
      grepArg: '"disabled"',
      fixed: true,
      pathspecs: ["plugins/**/package.json"],
    });

    const offenders: string[] = [];
    for (const { rel, src } of candidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(src);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // Not swallowed: a package.json that does not parse is a real problem,
        // and skipping it would silently exempt whatever it declares from this
        // check.
        return {
          ok: false,
          message: `${rel} is not valid JSON: ${err.message}`,
          hint: "Fix the file — an unparseable package.json exempts its plugin from every package.json-reading check.",
        };
      }
      const own = (parsed as Record<string, unknown>)[PLUGIN_MANIFEST_KEY];
      // Presence, not truthiness. `"disabled": false` is just as inert and just
      // as misleading — the key means nothing at all now.
      if (own && typeof own === "object" && "disabled" in own) {
        offenders.push(rel);
      }
    }

    if (offenders.length === 0) return { ok: true };

    const lines = offenders.map((f) => `${f}  → "!${pluginIdFor(f)}.**"`);
    return {
      ok: false,
      message:
        `\`${PLUGIN_MANIFEST_KEY}.disabled\` declared in ${offenders.length} plugin package.json(s):\n    ` +
        lines.join("\n    "),
      hint:
        `The flag is GONE — nothing reads it, so leaving it in place would silently ship the plugin it claims to turn off. ` +
        `One mechanism decides whether a plugin is in the app: the \`${BASE_EXCLUSIONS_ID}\` composition row, whose negatives every composition inherits. ` +
        `Move each entry above to that row's \`entryPoints\` (the arrow shows the pattern to add) in plugins/plugin-meta/plugins/composition/core/config.ts, and delete the \`${PLUGIN_MANIFEST_KEY}.disabled\` block. ` +
        `A negative cascades exactly as the old flag did — the plugin, its subtree, and everything that transitively imports it.`,
    };
  },
};

export default check;
