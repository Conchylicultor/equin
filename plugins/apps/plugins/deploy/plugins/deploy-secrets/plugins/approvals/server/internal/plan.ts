import type { SecretWrite } from "@plugins/infra/plugins/secrets/core";
import {
  DEPLOY_SECRET_STATUS_LABELS,
  DeploySecretValueSchema,
  isPendingSecretStatus,
  type DeploySecretLocal,
  type DeploySecretRow,
} from "../../core/schemas";

/**
 * What this computer holds for one secret, read from its
 * `DeploySecrets.LocalValue` contribution — absent when it holds nothing.
 * The value itself stays out: only its preview and fingerprint go on a row.
 */
export type LocalReading =
  | {
      readonly kind: "set";
      readonly preview: string;
      readonly fingerprint: string;
      readonly caution: string | null;
    }
  | { readonly kind: "unusable"; readonly reason: string };

/** How many characters a masked preview shows at each end. */
const MASK_EDGE = 4;
/**
 * The shortest value a masked preview shows any of: its two ends are then at
 * most a quarter of it. A shorter value is all dots.
 */
const MASK_MIN_LENGTH = MASK_EDGE * 8;

/**
 * A local value as the row previews it. `plain` shows it whole (an identifier
 * that is not secret); `masked` shows only its first and last four characters,
 * enough to recognise a key, and nothing of a value too short to cut safely
 * (under {@link MASK_MIN_LENGTH}).
 */
export function previewLocalValue(
  value: string,
  reveal: "masked" | "plain",
): string {
  if (reveal === "plain") return value;
  if (value.length < MASK_MIN_LENGTH) return "•".repeat(8);
  return `${value.slice(0, MASK_EDGE)}…${value.slice(-MASK_EDGE)}`;
}

/**
 * Whether a local value can be a deploy value: the same rules Set value
 * applies, so an offered value never fails when it is stored.
 */
export function checkLocalValue(
  value: string,
): { ok: true } | { ok: false; reason: string } {
  const parsed = DeploySecretValueSchema.safeParse(value);
  return parsed.success
    ? { ok: true }
    : {
        ok: false,
        reason: `This computer's value cannot be used: ${parsed.error.issues[0]?.message ?? "not a valid value"}.`,
      };
}

/** One secret a composition's closure needs, merged across the plugins declaring it. */
export interface RequiredSecret {
  readonly key: string;
  readonly description: string;
  readonly plugins: readonly string[];
  /** Every declaring plugin marked it optional: the box runs without it. */
  readonly optional: boolean;
}

/**
 * The gate's diff — required against granted — as a pure function.
 *
 * - `values`: the current local value's fingerprint per key, absent when no
 *   value is set;
 * - `grants`: the approved fingerprint per key, for THIS deployment;
 * - `lastWrites`: the store's last write per key, absent when it holds none;
 * - `locals`: this computer's counterpart per key, absent when it holds none.
 *
 * Every required key gets a row. A grant for a key no longer required has no
 * row: it is dropped from the delivered env without asking, because removing a
 * secret from a box is always safe.
 */
export function diffSecrets(
  required: readonly RequiredSecret[],
  values: ReadonlyMap<string, string>,
  grants: ReadonlyMap<string, string>,
  lastWrites: ReadonlyMap<string, SecretWrite>,
  locals: ReadonlyMap<string, LocalReading>,
): DeploySecretRow[] {
  return required.map((r) => {
    const fingerprint = values.get(r.key) ?? null;
    const granted = grants.get(r.key);
    const status =
      fingerprint === null
        ? r.optional
          ? "not-set"
          : "missing-value"
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
      lastWrite: lastWrites.get(r.key) ?? null,
      local: localOf(locals.get(r.key), fingerprint),
    };
  });
}

function localOf(
  reading: LocalReading | undefined,
  current: string | null,
): DeploySecretLocal {
  if (reading === undefined) return { kind: "none" };
  if (reading.kind === "unusable") return reading;
  return {
    kind: "available",
    preview: reading.preview,
    fingerprint: reading.fingerprint,
    caution: reading.caution,
    sameAsCurrent: reading.fingerprint === current,
  };
}

/** The rows still waiting on the user, or none. */
export function pendingSecrets(
  rows: readonly DeploySecretRow[],
): DeploySecretRow[] {
  return rows.filter((r) => isPendingSecretStatus(r.status));
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
 * different descriptions are both kept. A key is optional only when every
 * plugin declaring it says so — one that needs it makes it required.
 */
export function mergeDeclarations(
  declared: readonly {
    plugin: string;
    key: string;
    description: string;
    optional: boolean;
  }[],
): RequiredSecret[] {
  const byKey = new Map<
    string,
    { descriptions: string[]; plugins: string[]; optional: boolean }
  >();
  for (const d of declared) {
    const entry = byKey.get(d.key) ?? {
      descriptions: [],
      plugins: [],
      optional: true,
    };
    entry.optional &&= d.optional;
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
      optional: e.optional,
    }));
}
