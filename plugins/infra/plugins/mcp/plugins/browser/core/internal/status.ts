import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/** Most sessions one host holds before it refuses a new one. */
export const MAX_SESSIONS = 32;
/** Most tabs one session holds; opening another closes its oldest. */
export const MAX_TABS = 5;
/** Most recent host-side failures the status keeps. */
export const MAX_HOST_ERRORS = 20;

export const AgentBrowserTabSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
});
export type AgentBrowserTab = z.infer<typeof AgentBrowserTabSchema>;

export const AgentBrowserSessionSchema = z.object({
  conversationId: z.string(),
  /** The deploy the session drives: `http://<namespace>.localhost:9000`. */
  origin: z.string(),
  openedAt: z.string(),
  /** When the session closes if no call touches it first. */
  idleDeadline: z.string(),
  tabs: z.array(AgentBrowserTabSchema).max(MAX_TABS),
});
export type AgentBrowserSession = z.infer<typeof AgentBrowserSessionSchema>;

export const AgentBrowserHostErrorSchema = z.object({
  at: z.string(),
  /** What the host was doing: `close-idle-session`, `revert-writes`, … */
  during: z.string(),
  message: z.string(),
});
export type AgentBrowserHostError = z.infer<typeof AgentBrowserHostErrorSchema>;

/**
 * What the host publishes in `status.json`, rewritten whole on every change.
 *
 * `ready` while it serves; `exited` is its last write, on a clean exit. A
 * status that says `ready` for a pid that is gone is a host that died without
 * saying so (SIGKILL, OOM) — the reader tells that apart by pid liveness.
 */
export const AgentBrowserHostStatusSchema = z.object({
  /** The socket protocol this host speaks. */
  protocol: z.number().int(),
  /** Content hash of the host's own source: which code it runs. */
  codeId: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  state: z.enum(["ready", "exited"]),
  /** `exited` only: why — `idle`, `upgrade`, `signal SIGTERM`, … */
  exitReason: z.string().nullable(),
  updatedAt: z.string(),
  /** When the host exits for want of sessions; `null` while any is open. */
  idleExitAt: z.string().nullable(),
  sessions: z.array(AgentBrowserSessionSchema).max(MAX_SESSIONS),
  errors: z.array(AgentBrowserHostErrorSchema).max(MAX_HOST_ERRORS),
});
export type AgentBrowserHostStatus = z.infer<
  typeof AgentBrowserHostStatusSchema
>;

/**
 * The machine's agent browser as a backend reads it: never launched (or its
 * files reclaimed), running, exited cleanly, or dead without a word.
 */
export const AgentBrowserStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("running"), host: AgentBrowserHostStatusSchema }),
  z.object({ kind: z.literal("exited"), host: AgentBrowserHostStatusSchema }),
  z.object({ kind: z.literal("died"), host: AgentBrowserHostStatusSchema }),
  z.object({ kind: z.literal("unreadable"), reason: z.string() }),
]);
export type AgentBrowserStatus = z.infer<typeof AgentBrowserStatusSchema>;

/**
 * The machine's agent browser — host process, sessions, tabs, deadlines —
 * pushed whenever the host rewrites its status file. Host-global: every
 * backend serves the same value.
 */
export const agentBrowserStatus = liveValue("agent-browser.status", {
  schema: AgentBrowserStatusSchema,
});
