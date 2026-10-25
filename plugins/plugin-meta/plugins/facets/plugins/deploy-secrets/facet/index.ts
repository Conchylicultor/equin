import { join, relative } from "path";
import {
  createFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  readIfExists,
  walkFiles,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { deploySecretsFacetDef, type DeploySecretsData } from "../core";
import { extractDeploySecrets } from "./extract";

/**
 * The deploy secrets a plugin declares in its `core/` — where a box-side
 * consumer imports them from, so `core/` is the one place a declaration may
 * live.
 */
export default createFacet<DeploySecretsData>({
  def: deploySecretsFacetDef,

  extract(ctx) {
    const files: string[] = [];
    walkFiles(join(ctx.dir, "core"), files);
    const declared = files.flatMap((f) => {
      const src = readIfExists(f);
      return src === null
        ? []
        : extractDeploySecrets(src, relative(ctx.dir, f));
    });
    declared.sort((a, b) => a.key.localeCompare(b.key));
    return { declared };
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    if (data.declared.length > 0) {
      facts.push({
        folder: "deploy-secrets",
        key: "Deploy secrets",
        values: data.declared.map((d) => `\`${d.key}\` — ${d.description}`),
      });
    }
    return facts;
  },
});
