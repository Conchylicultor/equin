import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * How much of a shell's output file's END the server reads per change.
 *
 * A background build can write megabytes; the band row wants one line and the
 * pane wants the recent screenful. A constant window keeps every push a
 * bounded read and a bounded payload however long the shell has been running.
 */
export const SHELL_OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * One background shell's output, as the server last read it.
 *
 * Three arms, because "no output" has three meanings a surface must not merge:
 *
 * - `present`       — the file exists. `tail` may be `""`: the shell has
 *                     written nothing YET, which is not the same as the file
 *                     being gone. `truncated` = the file is longer than the
 *                     window, so `tail` starts at the first line boundary
 *                     inside it rather than at the file's start.
 * - `unknown-shell` — the conversation's transcript records no background
 *                     `Bash` launch with this id. The server resolves the
 *                     path itself from the transcript (the browser never sends
 *                     one), so this is the answer to a forged or stale id.
 * - `gone`          — the launch is recorded, but its file is not on disk any
 *                     more (a reboot, or tmp cleanup).
 */
export const ShellOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("present"),
    /** The whole file's size in bytes, not the tail's. */
    size: z.number().int().nonnegative(),
    tail: z.string(),
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal("unknown-shell") }),
  z.object({ kind: z.literal("gone") }),
]);
export type ShellOutput = z.infer<typeof ShellOutputSchema>;

/**
 * The live tail of one background shell's output file, keyed by the
 * conversation (`id`) and the shell id Claude Code minted at launch. Pushed on
 * every write while subscribed. Not loaded yet is `pending` — never `present`
 * with an empty tail, which would read as "the shell printed nothing".
 */
export const shellOutput = liveValue("background-shell-output", {
  schema: ShellOutputSchema,
  params: ["id", "shellId"],
});

const ShellStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }),
  z.object({
    kind: z.literal("completed"),
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("failed"),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("killed") }),
  z.object({
    kind: z.literal("ended-unrecognized"),
    status: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("ended-without-reporting") }),
]);

/** One shell as the transcript records it — see `ShellFact` (shells.ts). */
export const ShellFactSchema = z.object({
  shellId: z.string(),
  toolUseId: z.string(),
  command: z.string(),
  description: z.string().optional(),
  outputFile: z.string(),
  startedAt: z.string(),
  end: z.object({ state: ShellStateSchema, endedAt: z.string() }).nullable(),
});

/**
 * A conversation's background shells as its WHOLE transcript records them
 * (`shellFactsOf`), served by the server so a pane holding only the latest
 * events still sees a shell launched long ago. Small: one entry per shell.
 */
export const conversationShellFacts = liveValue("background-shells.facts", {
  schema: z.array(ShellFactSchema),
  params: ["id"],
});
