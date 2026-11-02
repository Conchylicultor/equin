import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync } from "node:fs";
import {
  SentinelVitalsRecordSchema,
  type SentinelVitalsRecord,
} from "../../core";
import { readJsonFile, writeJsonAtomic } from "./json-file";

// The host-global vitals file: the sentinel worker writes the latest reading
// every tick (~500 bytes every 5 s, one thread); every backend reads it to serve
// `sentinel.vitals` behind the health report's Machine watcher detail.

export const VITALS_FILENAME = "vitals.json";

export function vitalsFilePath(dir: AppPath): AppPath {
  return joinAppPath(dir, VITALS_FILENAME);
}

/** What a vitals read found: no file yet, the reading, or why it cannot be read. */
export type SentinelVitalsRead =
  | { kind: "none" }
  | { kind: "recorded"; vitals: SentinelVitalsRecord }
  | { kind: "unreadable"; reason: string };

export function readSentinelVitals(dir: AppPath): SentinelVitalsRead {
  const read = readJsonFile(vitalsFilePath(dir), SentinelVitalsRecordSchema);
  switch (read.kind) {
    case "none":
    case "unreadable":
      return read;
    case "record":
      return { kind: "recorded", vitals: read.record };
  }
}

/** Write one reading, write-then-rename. Throws on failure — the caller decides. */
export function writeSentinelVitals(
  dir: AppPath,
  record: SentinelVitalsRecord,
): void {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(dir, VITALS_FILENAME, record, record.pid);
}
