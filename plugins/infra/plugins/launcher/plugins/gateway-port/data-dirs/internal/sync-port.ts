import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { LEGACY_GATEWAY_PORT } from "@plugins/infra/plugins/namespace/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  GATEWAY_PORT_FILENAME,
  gatewayOriginFor,
  parseGatewayPortRecord,
  servedGatewayPort,
  type GatewayPortRecord,
} from "../../core";
import { gatewayPortDir } from "..";

/** Where this account's port is recorded. */
export function gatewayPortFile(): AppPath {
  return gatewayPortDir.file(GATEWAY_PORT_FILENAME);
}

/**
 * The port record, read without leaving the thread — for the CLI, a check or a
 * script, in a synchronous spot (a URL it prints, a default argument). A
 * backend reads `loadGatewayPortRecord` (machine), or rather the gateway that
 * started it (`servedGatewayPort`, core).
 */
export function readGatewayPortRecordSync():
  { kind: "set"; record: GatewayPortRecord } | { kind: "unset" } {
  const file = gatewayPortFile();
  if (!existsSync(file)) return { kind: "unset" };
  return {
    kind: "set",
    record: parseGatewayPortRecord(readFileSync(file, "utf8"), file),
  };
}

/**
 * This account's gateway port, read without leaving the thread: the gateway
 * that started this process if one did, else the recorded port, else
 * {@link LEGACY_GATEWAY_PORT} — an install that has not moved yet. The
 * backend-safe twin is `resolveGatewayPort` (machine).
 */
export function gatewayPortSync(): number {
  if (readEnv("GATEWAY_PORT") !== undefined) return servedGatewayPort();
  const read = readGatewayPortRecordSync();
  return read.kind === "set" ? read.record.port : LEGACY_GATEWAY_PORT;
}

/** `http://localhost:<gatewayPortSync()>` — where `/gateway/*` and central's routes answer. */
export function gatewayOriginSync(): string {
  return gatewayOriginFor(gatewayPortSync());
}
