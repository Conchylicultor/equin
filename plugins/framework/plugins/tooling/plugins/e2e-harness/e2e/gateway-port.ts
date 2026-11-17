/**
 * This account's gateway port, as an e2e script reads it: the recorded port
 * file (`infra/launcher/gateway-port`'s data dir, parsed by its core), else
 * {@link LEGACY_GATEWAY_PORT} — the port of an install that has not moved yet.
 *
 * The data-dirs half's `gatewayPortSync()` also honours `EQUIN_GATEWAY_PORT`; this
 * one deliberately does not: no environment variable has a spelling in this
 * runtime (`e2e-harness:target-not-env-derived`, see target.ts), and a script
 * run by a person or an agent has no gateway parent to inherit one from.
 */
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { LEGACY_GATEWAY_PORT } from "@plugins/infra/plugins/namespace/core";
import {
  GATEWAY_PORT_FILENAME,
  parseGatewayPortRecord,
} from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import { gatewayPortDir } from "@plugins/infra/plugins/launcher/plugins/gateway-port/data-dirs";

let cached: number | undefined;

/** The port this account's gateway listens on (read once per run). */
export function harnessGatewayPort(): number {
  if (cached !== undefined) return cached;
  const file = gatewayPortDir.file(GATEWAY_PORT_FILENAME);
  cached = existsSync(file)
    ? parseGatewayPortRecord(readFileSync(file, "utf8"), file).port
    : LEGACY_GATEWAY_PORT;
  return cached;
}
