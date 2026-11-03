import { liveReadCode } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";

/**
 * The digest of the code this process serves compiled collection reads with
 * (query-resource's `liveReadCode`). Started at boot by source-digest, so it
 * describes the files this process loaded. It stamps what outlives the
 * process: every L2 definition and the epoch handoff record.
 */
export function liveReadDigest(): Promise<string> {
  return sourceDigest([liveReadCode]);
}
