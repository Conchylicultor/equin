import { z } from "zod";

/**
 * Where the code a report is about lives, as the WRITER saw it — what the
 * drain's staleness rule compares against main.
 *
 * `mergeBase` is the writer's `git merge-base HEAD main`; `paths` are the repo
 * files that report is about (for a stall, the files on its stacks). Main drops
 * the report when it has changed any of those files since `mergeBase`: the
 * problem may already be fixed there, and a report from out-of-date code would
 * be noise. An EMPTY `paths` names no code, so there is nothing to compare and
 * the report is filed.
 */
export const OutboxCodeSchema = z.object({
  mergeBase: z.string().regex(/^[0-9a-f]{40,64}$/, "a full git object id"),
  paths: z.array(
    z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith("/") && !p.split("/").includes(".."),
        "a repo-relative path",
      ),
  ),
});
export type OutboxCode = z.infer<typeof OutboxCodeSchema>;

/**
 * One outbox file. `version` so a future shape change is a loud parse failure
 * at the drain rather than a silently misread field.
 */
export const OutboxEntrySchema = z.object({
  version: z.literal(1),
  /** The report kind — must be registered on main, or the drain fails loudly. */
  kind: z.string().min(1),
  message: z.string(),
  /** The kind's payload, validated by the kind's own schema at the drain. */
  data: z.record(z.unknown()),
  code: OutboxCodeSchema.optional(),
  /** When the reported event happened (epoch ms) — not when main drained it. */
  occurredAt: z.number(),
  /** Who wrote it: for the drain's log lines and a foreign report's note. */
  writer: z.object({
    pid: z.number().int(),
    checkout: z.string(),
    /**
     * The writer's repository (`repositoryOf`): the realpath of its main
     * checkout, the same for every worktree of one clone. The outbox is
     * host-global, so another clone on the machine — an e2e's temp clone —
     * writes into it too, and the drain must know whose code `code` names.
     * Absent only on entries from writers older than the field.
     */
    repo: z.string().min(1).optional(),
  }),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** A report as a caller files it: the entry minus what the writer stamps. */
export interface ProcessReport {
  kind: string;
  message: string;
  data: Record<string, unknown>;
  code?: OutboxCode;
}

/**
 * The name of a COMPLETE entry: `<epoch ms>-<pid>-<random>.json`. The time
 * prefix makes a plain sort drain oldest first. A file being written has a
 * dot-prefixed temp name that never matches, so a reader cannot see half an
 * entry.
 */
const ENTRY_NAME = /^\d+-\d+-[a-z0-9]+\.json$/;

export function isOutboxEntryName(name: string): boolean {
  return ENTRY_NAME.test(name);
}

export function newOutboxEntryName(now: number, pid: number): string {
  return `${now}-${pid}-${Math.random().toString(36).slice(2, 10)}.json`;
}

/** The temp name an entry is written under before its rename. */
export function outboxTempName(entryName: string): string {
  return `.${entryName}.tmp`;
}

export function isOutboxTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".json.tmp");
}
