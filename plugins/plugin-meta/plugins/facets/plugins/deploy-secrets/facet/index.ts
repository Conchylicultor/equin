import { relative } from "path";
import {
  createFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  readIfExistsSync,
  walkFilesSync,
} from "@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core";
import { deploySecretsFacetDef, type DeploySecretsData } from "../core";
import { extractDeploySecrets } from "./extract";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * The deploy secrets a plugin declares in its `core/` — where a box-side
 * consumer imports them from, so `core/` is the one place a declaration may
 * live.
 */
export default createFacet<DeploySecretsData>({
  def: deploySecretsFacetDef,

  extract(ctx) {
    const files: AppPath[] = [];
    walkFilesSync(joinAppPath(ctx.dir, "core"), files);
    const declared = files.flatMap((f) => {
      const src = readIfExistsSync(f);
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
