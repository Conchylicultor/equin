import { z } from "zod";

/**
 * The wire between a backend and the agent-browser host (`bin/host.ts`): one
 * HTTP server on a Unix socket in the host's data dir. Bump on any change to
 * the routes or bodies below — a backend never talks to a host speaking
 * another protocol.
 */
export const HOST_PROTOCOL = 2;

/** Files in the host's data dir (`data-dirs`). */
export const HOST_FILES = {
  socket: "host.sock",
  pid: "host.pid",
  lock: "host.lock",
  status: "status.json",
} as const;

/** The origin a request over the socket carries; the socket is the address. */
export const HOST_ORIGIN = "http://agent-browser";

/**
 * What a conversation's routes (`/agents/…`) resolve against: the deploy its
 * checkout's last build registered, or nothing yet. An unbuilt checkout still
 * browses — absolute URLs work — and only a route is refused.
 */
export const HostTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deploy"),
    /** `http://<namespace>.localhost:9000`, no trailing slash. */
    origin: z.string(),
    namespace: z.string(),
  }),
  z.object({
    kind: z.literal("unbuilt"),
    /** The checkout no build has registered a deploy for. */
    checkout: z.string(),
  }),
]);
export type HostTarget = z.infer<typeof HostTargetSchema>;

export const HostCallBodySchema = z.object({
  conversationId: z.string().min(1),
  target: HostTargetSchema,
  tool: z.string(),
  args: z.unknown(),
});
export type HostCallBody = z.infer<typeof HostCallBodySchema>;

export const HostCloseBodySchema = z.object({
  conversationId: z.string().min(1),
});

export const HostShutdownBodySchema = z.object({ reason: z.string().min(1) });

/** A tool's answer — the same shape as the MCP tool result it becomes. */
export const HostToolResultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
  ),
});
export type HostToolResult = z.infer<typeof HostToolResultSchema>;

/** A tool that threw: its message is the agent's to read. */
export const HostErrorBodySchema = z.object({ error: z.string() });

export const HostCloseResultSchema = z.object({ closed: z.boolean() });

/**
 * The request-origin source one conversation's session stamps on every
 * request, so its durable writes are recorded under it and reverted alone when
 * it closes — never another conversation's, never an e2e run's.
 */
export function browserSessionSource(conversationId: string): string {
  return `mcp-browser:${conversationId}`;
}
