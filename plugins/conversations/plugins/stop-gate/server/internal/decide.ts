import type { StopGateResponse } from "../../core/endpoints";
import type { StopGateEntry, StopVerdict, StopWaiverEntry } from "./registry";

/**
 * The decision from what the gates and waivers said: `block` iff some gate
 * blocks and no waiver waives — every blocking reason joined. A waived block
 * is an `allow` carrying the waivers' reasons, for the log.
 */
export function decideStop(
  verdicts: readonly StopVerdict[],
  waivers: readonly (string | null)[],
): StopGateResponse {
  const blocks = verdicts.flatMap((v) =>
    v.kind === "block" ? [v.reason] : [],
  );
  if (blocks.length === 0) return { decision: "allow", reason: null };
  const waived = waivers.filter((w): w is string => w !== null);
  if (waived.length > 0) {
    return { decision: "allow", reason: waived.join("\n\n") };
  }
  return { decision: "block", reason: blocks.join("\n\n") };
}

/**
 * Ask every gate, and — only when one blocks — every waiver. One that throws
 * fails the whole decision, loudly: the hook then fails open, and says so.
 */
export async function evaluateStop(
  conversationId: string,
  gates: readonly StopGateEntry[],
  waivers: readonly StopWaiverEntry[],
): Promise<StopGateResponse> {
  const verdicts = await Promise.all(gates.map((g) => g.check(conversationId)));
  if (!verdicts.some((v) => v.kind === "block")) {
    return decideStop(verdicts, []);
  }
  const waived = await Promise.all(
    waivers.map((w) => w.waives(conversationId)),
  );
  return decideStop(verdicts, waived);
}
