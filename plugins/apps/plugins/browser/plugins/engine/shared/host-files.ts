import { z } from "zod";

/** The host's files in its services dir (`data-dirs`). */
export const HOST_FILES = {
  socket: "host.sock",
  pid: "host.pid",
  lock: "host.lock",
  status: "status.json",
} as const;

/** Origin of the host's HTTP routes over its Unix socket (the host is not on TCP). */
export const HOST_ORIGIN = "http://browser-engine";

/** `POST /shutdown {reason}`: close every page (persisting the profile) and exit. */
export const HostShutdownBodySchema = z.object({ reason: z.string() });

/**
 * What the host publishes in `status.json`, rewritten whole on every change.
 * `ready` while it serves; `exited` is its last write on a clean exit. `ready`
 * for a dead pid is a host that died without saying so.
 */
export const EngineHostStatusSchema = z.object({
  /** The wire protocol (`ENGINE_PROTOCOL`) this host speaks. */
  protocol: z.number().int(),
  /** Content hash of the host's own source (`bin/`, `shared/`, `core/`). */
  codeId: z.string(),
  pid: z.number().int(),
  /** The namespace whose backend launched it — the one that may replace it. */
  launchedBy: z.string(),
  startedAt: z.string(),
  state: z.enum(["ready", "exited"]),
  exitReason: z.string().nullable(),
  updatedAt: z.string(),
  /** Remote pages open (attached or not). */
  pages: z.number().int().min(0),
  /** Client sockets attached right now. */
  sockets: z.number().int().min(0),
  /** When the host exits for want of pages and sockets; `null` while any is open. */
  idleExitAt: z.string().nullable(),
});
export type EngineHostStatus = z.infer<typeof EngineHostStatusSchema>;

/** The machine's engine host as a backend reads it. */
export type EngineStatus =
  | { kind: "absent" }
  | { kind: "running"; host: EngineHostStatus }
  | { kind: "exited"; host: EngineHostStatus }
  | { kind: "died"; host: EngineHostStatus }
  | { kind: "unreadable"; reason: string };
