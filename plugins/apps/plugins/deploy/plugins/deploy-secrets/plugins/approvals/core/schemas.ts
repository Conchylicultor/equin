import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { SecretWriteSchema } from "@plugins/infra/plugins/secrets/core";

/**
 * The id of the site Settings tab's Secrets section — contributed under it
 * (`web/`) and named by the deploy gate's refusal (`server/`), which is how a
 * held run links to it. One spelling, here.
 */
export const SECRETS_SECTION_ID = "secrets";

/**
 * Where one required secret stands for one deployment:
 *
 * - `approved`       — a value is set and this deployment has a grant for
 *                      exactly that value's fingerprint;
 * - `new`            — a value is set, never approved for this deployment;
 * - `changed`        — approved once, but the value has changed since (a
 *                      rotation counts as new: nothing reaches the box unseen);
 * - `missing-value`  — no value has been entered yet;
 * - `not-set`        — an OPTIONAL secret with no value: nothing to approve,
 *                      nothing delivered, the box reads it `unset`.
 */
export const DEPLOY_SECRET_STATUSES = [
  "approved",
  "new",
  "changed",
  "missing-value",
  "not-set",
] as const;
export type DeploySecretStatus = (typeof DEPLOY_SECRET_STATUSES)[number];

/** The words each status is shown and listed with — one copy, used by both the UI and the gate's message. */
export const DEPLOY_SECRET_STATUS_LABELS: Record<DeploySecretStatus, string> = {
  approved: "approved",
  new: "new",
  changed: "value changed",
  "missing-value": "missing value",
  "not-set": "not set (optional)",
};

/**
 * Whether a status holds the deploy until the user acts — the one rule the
 * gate, delivery, the banner and the Checks row all read. `approved` ships its
 * value; `not-set` ships nothing, which an optional secret allows.
 */
export function isPendingSecretStatus(status: DeploySecretStatus): boolean {
  return status !== "approved" && status !== "not-set";
}

/**
 * This computer's counterpart of a secret (a `DeploySecrets.LocalValue`
 * contribution), as a row offers it:
 *
 * - `none`        — nothing on this computer names this secret, or it has no value;
 * - `available`   — a value the deploy can take: its `preview` (masked for a
 *                   credential — never the value), its `fingerprint` (the same
 *                   HMAC as the row's, so Use sends back the one the user SAW),
 *                   and whether it is already the current value;
 * - `unusable`    — a local value the deploy value rules refuse, and why.
 */
export const DeploySecretLocalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("available"),
    preview: z.string(),
    fingerprint: z.string(),
    /** A hint to weigh before reusing it (a key public in every page), or null. */
    caution: z.string().nullable(),
    sameAsCurrent: z.boolean(),
  }),
  z.object({ kind: z.literal("unusable"), reason: z.string() }),
]);
export type DeploySecretLocal = z.infer<typeof DeploySecretLocalSchema>;

/** One required secret of one deployment, as the Secrets section lists it. Never carries the value. */
export const DeploySecretRowSchema = z.object({
  /** The env var it is delivered as on the box. */
  key: z.string(),
  /** Every plugin in the closure that declares it (normally one). */
  plugins: wholeList(z.string(), {
    reason: "the plugins in one closure declaring the same key — normally one",
  }),
  description: z.string(),
  status: z.enum(DEPLOY_SECRET_STATUSES),
  /**
   * The current value's fingerprint (an HMAC under a local key — reveals
   * nothing about the value), or null when there is no value. The Approve
   * action sends it back, so what is approved is the value the user SAW: a
   * value replaced in between is refused instead of approved blind.
   */
  fingerprint: z.string().nullable(),
  /**
   * The value's last write as this deployment's instance sees it — when, set
   * or delete, and by which namespace (`null`: one that named none) — or null
   * when the store holds no write of it. Who, never what.
   */
  lastWrite: SecretWriteSchema.nullable(),
  /** This computer's counterpart, offered as "Use this computer's value". */
  local: DeploySecretLocalSchema,
});
export type DeploySecretRow = z.infer<typeof DeploySecretRowSchema>;

/**
 * What a deploy secret's value may be. It travels to the box as one
 * `KEY=value` line on converge's stdin and is handled there by shell builtins
 * on its way into `systemd-creds encrypt` — so rather than escape, the value is
 * restricted to printable ASCII with no whitespace, quotes, backslash or `$`,
 * which every API key in practice is. A value outside it is refused when it is
 * entered, not discovered on the box.
 */
export const DEPLOY_SECRET_VALUE_PATTERN =
  /^[\x21\x23\x25-\x26\x28-\x5b\x5d-\x7e]+$/;

export const DeploySecretValueSchema = z
  .string()
  .min(1, "enter a value")
  .max(4096)
  .regex(
    DEPLOY_SECRET_VALUE_PATTERN,
    "printable ASCII only — no spaces, quotes, backslash or $",
  );
