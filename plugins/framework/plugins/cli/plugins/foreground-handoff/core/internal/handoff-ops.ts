import type { OpKind } from "@plugins/infra/plugins/worktree/core";

/**
 * The ops an agent may run in a FOREGROUND Bash call.
 *
 * A foreground call is killed at its time limit (600 s at most), and an op
 * killed that way leaves the agent no handle on it. These two are short often
 * enough that forcing them into the background costs more than it saves — op-log,
 * 30 days: `test` p50 35 s, `check` p50 192 s — yet long often enough (11% /
 * 20% past 570 s, host-grant queue included) that the limit must never be what
 * ends them. So they run foreground under a deadline and hand themselves off
 * before it (`../cli`). `build`, `push` and `release` stay background-only:
 * most of their runs would hand off anyway.
 *
 * A closed list of op kinds, read by the guard (which calls may run foreground)
 * and the CLI mapper (which commands hand off) — one list, so the two cannot
 * disagree.
 */
export const FOREGROUND_HANDOFF_OPS = [
  "check",
  "test",
] as const satisfies readonly OpKind[];

export type HandoffOp = (typeof FOREGROUND_HANDOFF_OPS)[number];

export function isHandoffOp(name: string): name is HandoffOp {
  return (FOREGROUND_HANDOFF_OPS as readonly string[]).includes(name);
}

/**
 * How long before the call's limit the op hands off. Covers the CLI's own start
 * (dependency check, re-exec), the gap between the guard stamping the deadline
 * and the harness starting its clock, and the last output drain — with room to
 * spare, since handing off a minute early costs one `./equin await`, while
 * missing the limit costs the handle.
 */
export const HANDOFF_MARGIN_MS = 60_000;

/** The instant (epoch ms) an op in a call with `timeoutMs` must hand off by. */
export function foregroundDeadline(nowMs: number, timeoutMs: number): number {
  return nowMs + timeoutMs - HANDOFF_MARGIN_MS;
}
