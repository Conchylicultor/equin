import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { DeploySecret } from "../../core";
import type { DeploySecretValue } from "./read";

/**
 * Where a deploy secret's counterpart lives on the computer — the value this
 * machine already uses for the same thing (the Maps browser key in its
 * browser-config file), offered in the Secrets section as "Use this computer's
 * value" instead of pasting it by hand.
 *
 * Contributed by the plugin that owns the local value (its `machine/` half: a
 * box never reads it — the approvals side that does is never deployed), so the
 * Deploy app names no secret: it reads every contribution by the secret's key.
 * Reusing it stores the value through the ordinary Set value path, and the row
 * is approved like any other.
 */
export interface DeploySecretLocalValue {
  /** The deploy secret this is the local counterpart of. */
  readonly secret: DeploySecret;
  /**
   * How the value is previewed before it is used: `masked` (its first and
   * last characters) for a credential, `plain` for an identifier that is not
   * secret (a Map ID).
   */
  readonly reveal: "masked" | "plain";
  /**
   * A short hint shown beside the offer, when reusing the local value is a
   * choice to weigh rather than the obvious one (a key that ends up public in
   * every page of the site, where a separate restricted key is advised).
   */
  readonly caution?: string;
  /** The local value now; `unset` when this computer has none. */
  read(): Promise<DeploySecretValue>;
  /** Call `changed` whenever the local value may have moved, while someone reads it; returns the stop. */
  watch(changed: () => void): Promise<() => void>;
}

export const DeploySecrets = {
  LocalValue: defineServerContribution<DeploySecretLocalValue>(
    "deploy-secrets.local-value",
    { docLabel: (c) => c.secret.key },
  ),
};
