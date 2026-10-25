/**
 * Env-var spelling of a deploy secret's key: what the box's EnvironmentFile
 * holds it under, so it must be a valid shell variable name.
 */
export const DEPLOY_SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * One secret a deployed composition needs on its box. Plain data: the plugin
 * that needs it exports it from its `core/`, and the deploy side discovers
 * every declaration in a composition's closure — never by name.
 */
export interface DeploySecret {
  readonly kind: "deploy-secret";
  /** The env var it is delivered as on the box (`RESEND_API_KEY`). */
  readonly key: string;
  /** What it is for, in one sentence — shown on the approval card. */
  readonly description: string;
}

export function defineDeploySecret(spec: {
  key: string;
  description: string;
}): DeploySecret {
  if (!DEPLOY_SECRET_KEY_PATTERN.test(spec.key)) {
    throw new Error(
      `defineDeploySecret: key ${JSON.stringify(spec.key)} is not an env-var name (${DEPLOY_SECRET_KEY_PATTERN})`,
    );
  }
  return {
    kind: "deploy-secret",
    key: spec.key,
    description: spec.description,
  };
}
