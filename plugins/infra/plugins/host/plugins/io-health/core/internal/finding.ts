import { z } from "zod";

/**
 * The closed set of ways the detector says host file I/O is degraded. Each is
 * one sustained condition read from the fs-latency monitor's ticks; the rule's
 * thresholds and why are in `detect.ts`.
 */
export const IO_HEALTH_RULES = [
  /** A watched system daemon (fseventsd, syspolicyd, …) sustained high CPU. */
  "daemon-cpu",
  /** The disk takes several times its healthy time per read op. */
  "device-latency",
  /** A single cold metadata op (lstat / readdir) took over a second. */
  "metadata-stall",
  /** Renames on the volume were held for hundreds of ms, tick after tick. */
  "rename-stall",
  /** A watched daemon is relaunched over and over (a new pid each run). */
  "relaunch-loop",
  /** The file cache drops files within minutes with the disk quiet and no memory demand measured reclaiming it. */
  "cache-collapse",
  /** Memory demand (anonymous allocation) reclaims the file cache within minutes while the disk is quiet. */
  "memory-pressure",
  /** The machine generates file events at a rate no healthy hour reaches (a runaway writer). */
  "fsevents-flood",
  /** The monitor's root daemon is installed but not the one writing (its plist empty, invalid or unloaded, or it is silent). */
  "root-daemon",
] as const;
export type IoHealthRule = (typeof IO_HEALTH_RULES)[number];

export const EvidenceSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** At most this many evidence lines per finding. */
export const EVIDENCE_MAX = 8;

export const FindingSchema = z.object({
  rule: z.enum(IO_HEALTH_RULES),
  /** What the rule is about: a daemon's name, or `disk` / `probe` / `volume` / `cache` / `memory` / `root-daemon`. */
  subject: z.string(),
  severity: z.enum(["attention", "critical"]),
  /** One sentence, the report's message and the health row's summary. */
  summary: z.string(),
  /** Epoch ms of the first tick this finding held on, without a break. */
  since: z.number(),
  evidence: z.array(EvidenceSchema).max(EVIDENCE_MAX),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A finding's identity: one report row and one bell per rule and subject. */
export function findingKey(f: Pick<Finding, "rule" | "subject">): string {
  return `${f.rule}:${f.subject}`;
}
