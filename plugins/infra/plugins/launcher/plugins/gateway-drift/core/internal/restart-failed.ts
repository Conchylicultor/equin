import { z } from "zod";

/** The longest line a `gateway-restart-failed` payload keeps (cut past it). */
export const RESTART_FAILED_LINE_MAX = 2_000;
/** The most lines of one error it keeps (the last ones). */
export const RESTART_FAILED_TAIL_LINES = 60;

const Line = z.string().max(RESTART_FAILED_LINE_MAX + 1);
const Tail = z.array(Line).max(RESTART_FAILED_TAIL_LINES);

/**
 * The jsonb payload of a `gateway-restart-failed` report: main's follow-main
 * step (`./equin build --allow-main --converge`, `gateway-drift/cli`) swapped
 * the machine's gateway for main's and the new one did not come up — or it
 * would not try, because it could not have gone back. Filed by that run through
 * the report outbox; nothing retries the same launch (the next push that
 * changes the gateway is the next try).
 */
export const GatewayRestartFailedPayloadSchema = z.strictObject({
  /** The gateway build it tried to install (`gateway-binary@<identity>`). */
  to: Line,
  /** The build that ran before (the one the rollback reinstalls). */
  from: Line.nullable(),
  /** Why it was restarting: the drift row's phrases. */
  differences: z.array(Line).max(32),
  /**
   * `refused`: it did not touch the gateway (it could not have gone back);
   * `failed`: the new gateway was loaded and did not come up.
   */
  stage: z.enum(["refused", "failed"]),
  /** The error, last lines first-to-last (the new gateway's own output included). */
  error: Tail,
  /** The rollback to the previous gateway: none needed, done, or failed too. */
  rollback: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-needed") }),
    z.object({ kind: z.literal("restored"), pid: z.number().int().nullable() }),
    z.object({ kind: z.literal("failed"), error: Tail }),
  ]),
  /** Main's checkout, and the run's log (gateway `deploy/main.log`). */
  checkout: z.string(),
  /** Epoch ms. */
  at: z.number(),
});
export type GatewayRestartFailedPayload = z.infer<
  typeof GatewayRestartFailedPayloadSchema
>;

/** One line: `main's gateway did not come up (rolled back)`. */
export function describeGatewayRestartFailed(
  d: GatewayRestartFailedPayload,
): string {
  if (d.stage === "refused")
    return "main's gateway was not installed: the previous one could not be restored";
  switch (d.rollback.kind) {
    case "restored":
      return "main's gateway did not come up — the previous one runs again";
    case "failed":
      return "main's gateway did not come up, and the previous one could not be restored";
    case "not-needed":
      return "main's gateway could not be installed — the previous one keeps running";
  }
}

/** An error as bounded lines for the payload. */
export function errorLines(err: unknown): string[] {
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  return text
    .split("\n")
    .slice(-RESTART_FAILED_TAIL_LINES)
    .map((l) =>
      l.length > RESTART_FAILED_LINE_MAX
        ? `${l.slice(0, RESTART_FAILED_LINE_MAX)}…`
        : l,
    );
}
