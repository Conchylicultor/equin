import { MandatePolicySchema, type MandatePolicy } from "../internal/define";

/**
 * A policy as raw grants, unchecked by any capability — for a test of how a
 * reader handles a value its capability's schema refuses, which
 * `mandatePolicy` (parsing every grant) can never build.
 */
export function rawPolicy(grants: Record<string, unknown>): MandatePolicy {
  return MandatePolicySchema.parse(grants);
}
