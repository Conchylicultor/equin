import { z } from "zod";

/**
 * The wire between a backend and the agent-browser host (`bin/host.ts`): one
 * HTTP server on a Unix socket in the host's data dir. Bump on any change to
 * the routes or bodies below — a backend never talks to a host speaking
 * another protocol. The one exception is an ADDED read route whose absence the
 * backend reads as an answer (a 404 it handles), so adding it does not lock
 * every other checkout out of the running host; a REMOVED route no backend
 * calls any more needs no bump either.
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
    /** `http://<namespace>.localhost:<port>`, no trailing slash. */
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

/**
 * `POST /capture-pair` — two pages captured in the conversation's session at
 * one viewport and colour scheme, for a before / after pair
 * (`conversations/before-after`). Not an MCP tool of its own (it is not in
 * `shared/tools.ts`): the backend resolves both URLs (main and this
 * conversation's build) and the host opens each in a THROWAWAY page of the
 * session's context — the agent's tabs, and which one is current, untouched —
 * waits until it is ready (`waitForScreenReady`), captures it and closes it.
 *
 * An ADDED route, so no `HOST_PROTOCOL` bump: a host that predates it answers
 * 404, which the backend reads as "this host cannot capture yet" — bumping
 * would instead lock every checkout on the old protocol out of every browser
 * tool until main replaced the host.
 */
export const HostCapturePairBodySchema = z.object({
  conversationId: z.string().min(1),
  target: HostTargetSchema,
  /** Absolute http(s) URLs: the backend resolved both. */
  urls: z.tuple([z.string().url(), z.string().url()]),
  viewport: z.object({
    width: z.number().int().min(200).max(4000),
    height: z.number().int().min(200).max(4000),
  }),
  colorScheme: z.enum(["light", "dark"]),
});
export type HostCapturePairBody = z.infer<typeof HostCapturePairBodySchema>;

/** One captured page: its PNG and what its readiness wait saw. */
export const HostCaptureShotSchema = z.object({
  /** Base64 PNG of the viewport. */
  png: z.string(),
  /** Where the page ended (after redirects). */
  url: z.string(),
  /** The document's HTTP status (`null`: none reported). */
  httpStatus: z.number().int().nullable(),
  paintedAfterMs: z.number(),
  /** Loaders still visible at the readiness deadline (captured anyway). */
  stillBusy: z.array(z.string()),
});
export type HostCaptureShot = z.infer<typeof HostCaptureShotSchema>;

export const HostCapturePairResultSchema = z.object({
  shots: z.tuple([HostCaptureShotSchema, HostCaptureShotSchema]),
  /** How long the capture queued for a browser slot (the host-wide e2e pool). */
  slotWaitedMs: z.number(),
});
export type HostCapturePairResult = z.infer<typeof HostCapturePairResultSchema>;

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
