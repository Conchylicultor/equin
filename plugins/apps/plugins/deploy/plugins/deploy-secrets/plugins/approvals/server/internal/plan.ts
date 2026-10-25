import {
  DEPLOY_SECRET_STATUS_LABELS,
  type DeploySecretRow,
} from "../../core/schemas";

/** One secret a composition's closure needs, merged across the plugins declaring it. */
export interface RequiredSecret {
  readonly key: string;
  readonly description: string;
  readonly plugins: readonly string[];
}

/**
 * The gate's diff — required against granted — as a pure function.
 *
 * - `values`: the current local value's fingerprint per key, absent when no
 *   value is set;
 * - `grants`: the approved fingerprint per key, for THIS deployment.
 *
 * Every required key gets a row. A grant for a key no longer required has no
 * row: it is dropped from the delivered env without asking, because removing a
 * secret from a box is always safe.
 */
export function diffSecrets(
  required: readonly RequiredSecret[],
  values: ReadonlyMap<string, string>,
  grants: ReadonlyMap<string, string>,
): DeploySecretRow[] {
  return required.map((r) => {
    const fingerprint = values.get(r.key) ?? null;
    const granted = grants.get(r.key);
    const status =
      fingerprint === null
        ? "missing-value"
        : granted === undefined
          ? "new"
          : granted === fingerprint
            ? "approved"
            : "changed";
    return {
      key: r.key,
      plugins: [...r.plugins],
      description: r.description,
      status,
      fingerprint,
    };
  });
}

/** The rows still waiting on the user, or none. */
export function pendingSecrets(
  rows: readonly DeploySecretRow[],
): DeploySecretRow[] {
  return rows.filter((r) => r.status !== "approved");
}

/**
 * The sentence a held run ends with: every pending key with its status, and
 * where to act. Keys only — a message is stored and shown, never a value.
 */
export function approvalMessage(pending: readonly DeploySecretRow[]): string {
  const items = pending
    .map((r) => `${r.key} (${DEPLOY_SECRET_STATUS_LABELS[r.status]})`)
    .join(", ");
  return (
    `This deployment needs ${pending.length === 1 ? "a deploy secret" : "deploy secrets"} ` +
    `that you have not approved for this server: ${items}. ` +
    `Set and approve ${pending.length === 1 ? "it" : "each one"} in the Secrets section of this deployment, then deploy again. ` +
    `Nothing was converged or shipped.`
  );
}

/**
 * Merge the closure's declarations by key. Two plugins may need the same env
 * var (they share one value on the box), so a key is one row naming both; two
 * different descriptions are both kept.
 */
export function mergeDeclarations(
  declared: readonly { plugin: string; key: string; description: string }[],
): RequiredSecret[] {
  const byKey = new Map<
    string,
    { descriptions: string[]; plugins: string[] }
  >();
  for (const d of declared) {
    const entry = byKey.get(d.key) ?? { descriptions: [], plugins: [] };
    if (!entry.descriptions.includes(d.description))
      entry.descriptions.push(d.description);
    if (!entry.plugins.includes(d.plugin)) entry.plugins.push(d.plugin);
    byKey.set(d.key, entry);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({
      key,
      description: e.descriptions.join(" / "),
      plugins: e.plugins.sort(),
    }));
}
