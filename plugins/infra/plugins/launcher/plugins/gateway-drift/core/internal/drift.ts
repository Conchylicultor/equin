import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/** What brings the machine's gateway onto what this checkout's main installs. */
export const GATEWAY_REFRESH_COMMAND = "./equin start --force";

/**
 * Is the machine's gateway the one `./equin start --force` would install now?
 *
 * - `current`        — the installed definition and the running gateway match
 *                      main's launch (argv, cwd, signature);
 * - `stale`          — they do not; `differences` says how, one short phrase
 *                      each ("-listen :9000 → loopback:9000");
 * - `not-applicable` — there is no login-service gateway this backend runs
 *                      behind (no service manager, a release, another data
 *                      root): nothing to compare;
 * - `unreadable`     — the check itself failed; not a verdict on the gateway.
 */
export const GatewayDriftSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({
    kind: z.literal("stale"),
    differences: wholeList(z.string(), {
      reason:
        "one phrase per kind of difference (binary, each changed flag, cwd, signature, running vs installed) — a fixed handful",
    }),
  }),
  z.object({ kind: z.literal("not-applicable"), reason: z.string() }),
  z.object({ kind: z.literal("unreadable"), message: z.string() }),
]);
export type GatewayDrift = z.infer<typeof GatewayDriftSchema>;
