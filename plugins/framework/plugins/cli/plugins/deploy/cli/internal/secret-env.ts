/**
 * The deploy secrets converge delivers: fetched from this checkout's backend
 * (the one place that knows what was approved), rendered as the `KEY=value`
 * lines the converge script reads from stdin.
 */
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { DEPLOY_SECRET_KEY_PATTERN } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";
import {
  DEPLOY_SECRET_VALUE_PATTERN,
  deliverDeploySecrets,
} from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/plugins/approvals/core";
import { refuse, toBackend } from "./target";

export interface SecretEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Every secret this deployment's closure needs, each approved for exactly its
 * current value — or a refusal, BEFORE the first host mutation, with the same
 * sentence the deploy gate gives. Asked again here (not trusted from the gate)
 * because a value can change between the gate and this leg, and because
 * converge can be run by hand.
 */
export async function approvedSecretEnv(
  deploymentId: string,
): Promise<SecretEntry[]> {
  const answer = await toBackend((origin) =>
    callEndpoint(deliverDeploySecrets, { deploymentId }, { origin }),
  );
  if (answer.kind === "needs-approval") refuse(answer.message);
  return [...answer.env].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The stdin the converge script reads its secrets from: one `KEY=value` line
 * each. Both halves are re-asserted at the boundary — a key that is not an
 * env-var name or a value the env file cannot hold verbatim would otherwise
 * corrupt the file on the box. The error names the key, never the value.
 */
export function secretEnvStdin(entries: readonly SecretEntry[]): string {
  return entries
    .map(({ key, value }) => {
      if (!DEPLOY_SECRET_KEY_PATTERN.test(key)) {
        throw new Error(
          `deploy secret key ${JSON.stringify(key)} is not an env-var name.`,
        );
      }
      if (!DEPLOY_SECRET_VALUE_PATTERN.test(value)) {
        throw new Error(
          `the value of deploy secret ${key} has characters converge's stdin lines cannot carry verbatim.`,
        );
      }
      return `${key}=${value}\n`;
    })
    .join("");
}
