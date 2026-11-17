import { z } from "zod";
import {
  GATEWAY_PORT_RANGE,
  LEGACY_GATEWAY_PORT,
  isGatewayPort,
} from "@plugins/infra/plugins/namespace/core";

/** The port file's name inside its data dir (`state/gateway-port/`). */
export const GATEWAY_PORT_FILENAME = "port.json";

/**
 * What the port file records: this account's port, and the port the account
 * moved off (`legacy`), which its gateway keeps answering on for a while
 * (`-legacy-listen`) so bookmarks, open tabs and running agent sessions follow.
 * `legacy` is set only by a move off {@link LEGACY_GATEWAY_PORT}; a fresh
 * install never listens there.
 */
export const GatewayPortRecordSchema = z
  .object({
    port: z
      .number()
      .int()
      .refine(isGatewayPort, {
        message: `port must be one of ${GATEWAY_PORT_RANGE.first}…${GATEWAY_PORT_RANGE.last}`,
      }),
    legacy: z.literal(LEGACY_GATEWAY_PORT).nullable(),
  })
  .strict();

export type GatewayPortRecord = z.infer<typeof GatewayPortRecordSchema>;

/** Parse the port file's text; throws naming the file on anything malformed. */
export function parseGatewayPortRecord(
  text: string,
  file: string,
): GatewayPortRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[gateway-port] ${file} is not JSON (${String(err)}). It records this account's gateway port; ` +
        `run \`./equin start --port <${GATEWAY_PORT_RANGE.first}…${GATEWAY_PORT_RANGE.last}>\` to write it again.`,
    );
  }
  const parsed = GatewayPortRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[gateway-port] ${file} does not hold a gateway port record: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The text the port file is written as. */
export function renderGatewayPortRecord(record: GatewayPortRecord): string {
  return `${JSON.stringify(GatewayPortRecordSchema.parse(record))}\n`;
}

/** The loopback origin of the gateway on `port` — central's routes and `/gateway/*` answer on every host. */
export function gatewayOriginFor(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * The `-legacy-listen` address a launch carries for a record: the legacy port
 * on loopback while the record names one, else none.
 */
export function legacyListenOf(
  record: GatewayPortRecord | null,
): number | null {
  return record?.legacy ?? null;
}
