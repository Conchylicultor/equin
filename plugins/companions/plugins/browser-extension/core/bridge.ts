import { z } from "zod";
import { EXTENSION_ORIGIN } from "./extension-id";

/**
 * The bridge between the extension's shell (`browser-extension/popup.ts`) and
 * the equin page it frames — the contract both halves parse, mirroring the
 * menu bar's `native-bridge.ts`.
 *
 * Transport: the page, once it listens, says hello to its parent (posted to
 * the extension's origin only); the shell answers a hello from its own iframe
 * — pinned to the equin origin it framed — with a fresh `MessagePort`. Every
 * call then goes over that port. The page accepts a port only from the
 * extension's origin (`acceptBridgePort`), so a foreign page framing equin
 * gets no bridge.
 */

/** What the host can do. A capability a shell lacks is `false`, and the page
 *  hides what would use it. `setHeight` and `reload` are every shell's. */
export const ExtensionCapabilitiesSchema = z.object({
  /** Read the tab the popup is about (`activeTab`). */
  activeTab: z.boolean(),
  /** Navigate that tab (`navigate`). */
  navigate: z.boolean(),
  /** Open a new tab (`openTab`). */
  openTab: z.boolean(),
  /** Close the popup (`close`). */
  close: z.boolean(),
});
export type ExtensionCapabilities = z.infer<typeof ExtensionCapabilitiesSchema>;

/** `hostInfo()`'s answer. `shellDigest` names the shell's own build: the page
 *  reloads the extension when the served shell's differs. */
export const ExtensionHostInfoSchema = z.object({
  version: z.literal(1),
  shellDigest: z.string().min(1),
  capabilities: ExtensionCapabilitiesSchema,
});
export type ExtensionHostInfo = z.infer<typeof ExtensionHostInfoSchema>;

/** The tab the popup is about. */
export const ActiveTabSchema = z.object({
  url: z.string(),
  title: z.string(),
});
export type ActiveTab = z.infer<typeof ActiveTabSchema>;

const UrlParams = z.object({ url: z.url() });
const NoParams = z.object({});

/** One call, by method. */
export const BridgeCallSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("hostInfo"), params: NoParams }),
  z.object({ method: z.literal("activeTab"), params: NoParams }),
  z.object({ method: z.literal("navigate"), params: UrlParams }),
  z.object({ method: z.literal("openTab"), params: UrlParams }),
  z.object({ method: z.literal("close"), params: NoParams }),
  z.object({
    method: z.literal("setHeight"),
    params: z.object({ px: z.number().int().nonnegative() }),
  }),
  z.object({ method: z.literal("reload"), params: NoParams }),
]);
export type BridgeCall = z.infer<typeof BridgeCallSchema>;
export type BridgeMethod = BridgeCall["method"];

/** What each method answers; every other method answers `null`. */
export const BRIDGE_RESULTS = {
  hostInfo: ExtensionHostInfoSchema,
  activeTab: ActiveTabSchema,
  navigate: z.null(),
  openTab: z.null(),
  close: z.null(),
  setHeight: z.null(),
  reload: z.null(),
} as const satisfies Record<BridgeMethod, z.ZodType>;
export type BridgeResult<M extends BridgeMethod> = z.infer<
  (typeof BRIDGE_RESULTS)[M]
>;

/** A call on the port: its id and the call. */
export const BridgeRequestSchema = z
  .object({ id: z.number().int() })
  .and(BridgeCallSchema);
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

/** A call's answer on the port. */
export const BridgeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.string() }),
]);
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

/** The page's hello to its parent, asking for the port. */
export const BRIDGE_HELLO = { type: "equin-bridge-hello" } as const;
export const BridgeHelloSchema = z.object({
  type: z.literal(BRIDGE_HELLO.type),
});

/** The shell's answer to a hello, carrying the port. */
export const BRIDGE_PORT = { type: "equin-bridge-port", version: 1 } as const;
const BridgePortSchema = z.object({
  type: z.literal(BRIDGE_PORT.type),
  version: z.literal(1),
});

/** The parts of a `message` event the port check reads. */
export interface BridgePortMessage<Port, Source> {
  origin: string;
  source: Source | null;
  data: unknown;
  ports: readonly Port[];
}

/**
 * The bridge port a message hands the page, or `null` when it is not the
 * extension's: it must come from the page's own parent, from the extension's
 * origin, in the port message's shape, with exactly one port. Anything else —
 * a foreign page framing equin, another window posting — is not a bridge.
 */
export function acceptBridgePort<Port, Source>(
  event: BridgePortMessage<Port, Source>,
  parent: Source,
): Port | null {
  if (event.origin !== EXTENSION_ORIGIN) return null;
  if (event.source !== parent) return null;
  if (!BridgePortSchema.safeParse(event.data).success) return null;
  const [port] = event.ports;
  if (port === undefined || event.ports.length !== 1) return null;
  return port;
}
