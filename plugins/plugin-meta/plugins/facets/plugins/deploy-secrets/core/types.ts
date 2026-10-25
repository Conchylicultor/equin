import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";

/**
 * One `defineDeploySecret({ key, description })` call found in a plugin's
 * `core/` — a secret the plugin needs on the box it is deployed to.
 */
export interface DeclaredDeploySecret {
  /** The env var it is delivered as on the box (`RESEND_API_KEY`). */
  key: string;
  /** What it is for, in one sentence. */
  description: string;
  /** The declaring file, relative to the plugin's own folder. */
  file: string;
}

export interface DeploySecretsData {
  declared: DeclaredDeploySecret[];
}

/**
 * The deploy secrets a plugin declares. Read by the deploy side to compute
 * every secret a composition's closure needs — the facet is the discovery, so
 * the deploy side names no plugin that needs one.
 */
export const deploySecretsFacetDef =
  defineFacet<DeploySecretsData>("deploy-secrets");
