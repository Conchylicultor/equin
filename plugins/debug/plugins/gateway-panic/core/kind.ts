import { z } from "zod";
import {
  CrashLineSchema,
  CrashTailSchema,
} from "@plugins/debug/plugins/backend-crash/core";

// The jsonb payload of a `gateway-panic` report. Written by the GATEWAY (Go,
// gateway/handler_panic.go `gatewayPanic`) into the report outbox, so this
// schema is a cross-language contract: gateway/testdata/gateway-panic-entry.json
// is what the Go writer produces, and kind.test.ts parses it with this schema.
// Strict: a field the Go writer adds must be added here too.
export const GatewayPanicPayloadSchema = z.strictObject({
  /** The function the panic was raised in, e.g. `equin/gateway.(*backend).incHTTP`. */
  site: z.string(),
  /** The recovered value, as text (one bounded line). */
  value: CrashLineSchema,
  /** The panicking goroutine's stack from the panic down, bounded. */
  stack: CrashTailSchema,
  /** The request it was serving (the latest, for a coalesced entry). */
  method: z.string(),
  host: z.string(),
  path: z.string(),
  /** How many panics at this site the entry covers. */
  count: z.number().int().positive(),
  /** Epoch ms of the first and last of them. */
  firstAt: z.number(),
  lastAt: z.number(),
});
export type GatewayPanicPayload = z.infer<typeof GatewayPanicPayloadSchema>;

/** One line: `gateway panicked in (*backend).incHTTP serving GET /api/health (240×)`. */
export function describeGatewayPanic(d: GatewayPanicPayload): string {
  const site = d.site.replace(/^equin\/gateway\./, "");
  const times = d.count > 1 ? ` (${d.count}×)` : "";
  return `gateway panicked in ${site} serving ${d.method} ${d.path}${times}`;
}
