import { z } from "zod";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it, the web dispatches its `Reports.KindView` on it, and
 * `./equin check --file-reports` files under it.
 */
export const HOST_CHECK_KIND = "host-check";

/**
 * One failing host-scoped check, as the host audit saw it. The message and hint
 * are the check's own, verbatim — the row keeps the latest run's, so it names
 * what is wrong on the machine NOW, not when the row was first filed.
 */
export const HostCheckPayloadSchema = z.object({
  /** The check's id (`paths:no-undeclared-data-dirs`). */
  checkId: z.string(),
  /** The check's failure message. */
  message: z.string(),
  hint: z.string().nullable(),
});
export type HostCheckPayload = z.infer<typeof HostCheckPayloadSchema>;

/** One row per host check: each failing audit bumps that check's count. */
export function hostCheckFingerprint(d: HostCheckPayload): string {
  return `${HOST_CHECK_KIND}:${d.checkId}`;
}

/** The first line of a long message, cut to fit a list row. */
function firstLine(message: string): string {
  const line = message.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * The one-line summary — the report row's `message`, and the KindView's text:
 * `host check paths:no-undeclared-data-dirs failed — 1 problem(s) under …`.
 */
export function hostCheckMessage(d: HostCheckPayload): string {
  return `host check ${d.checkId} failed — ${firstLine(d.message)}`;
}
