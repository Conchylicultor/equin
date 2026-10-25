import { z } from "zod";
import { SshFailureKindSchema } from "@plugins/infra/plugins/ssh/core";

/** curl's own exit codes a failed remote request is explained by. */
export const CURL_EXIT = {
  /** Nothing listening on the loopback port: the install is down. */
  couldNotConnect: 7,
  /**
   * HTTP status >= 400 (`-f`): typically 404, the deployed release does not
   * ship the plugin that answers the route yet.
   */
  httpError: 22,
  /** `-m` deadline passed: the box took too long to answer. */
  timedOut: 28,
} as const;

/**
 * Every way asking a deployment's box can fail before it answers, as zod arms
 * a consumer spreads beside its own answer's arms — so a host-only read's
 * result is `answer | failure`, never an empty answer:
 *
 * - `no-ssh-key` — the server has no SSH key yet.
 * - `unverified` — the server's host key was never pinned: the connection
 *   check has not succeeded once, so the box's identity is unknown.
 * - `ssh-failed` — SSH itself failed (unreachable, auth, host key changed…).
 * - `request-failed` — SSH worked; the curl on the box failed (`exitCode` is
 *   curl's, see {@link CURL_EXIT}).
 * - `unreadable-answer` — the box answered something that is not the answer.
 */
export const HOST_QUERY_FAILURE_ARMS = [
  z.object({ kind: z.literal("no-ssh-key") }).strict(),
  z.object({ kind: z.literal("unverified") }).strict(),
  z
    .object({
      kind: z.literal("ssh-failed"),
      failure: SshFailureKindSchema,
      message: z.string(),
      stderr: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request-failed"),
      exitCode: z.number().int().nullable(),
      stderr: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unreadable-answer"),
      /** Why parsing failed, and the head of what came back. */
      detail: z.string(),
    })
    .strict(),
] as const;

export type HostQueryFailure = z.infer<
  (typeof HOST_QUERY_FAILURE_ARMS)[number]
>;

/** The failure kinds, derived from the arms so the two cannot drift. */
const FAILURE_KINDS: ReadonlySet<string> = new Set(
  HOST_QUERY_FAILURE_ARMS.map((arm) => arm.shape.kind.value),
);

/** Narrow a consumer's `answer | failure` result to its failure arm. */
export function isHostQueryFailure<T extends { kind: string }>(
  result: T | HostQueryFailure,
): result is HostQueryFailure {
  return FAILURE_KINDS.has(result.kind);
}
