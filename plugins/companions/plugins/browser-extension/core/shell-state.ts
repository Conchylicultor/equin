import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";

/** The shell and its connection are files on the computer. */
const NEEDS_MACHINE = { feature: "The browser extension" };

/**
 * The extension shell this namespace's build wrote — the one framing this
 * namespace: `built` with its digest and the folder Chrome loads it from
 * (`chrome://extensions` → Load unpacked), `absent` before any build wrote it.
 */
export const ShellStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), path: z.string() }),
  z.object({
    kind: z.literal("built"),
    path: z.string(),
    digest: z.string(),
  }),
]);
export type ShellState = z.infer<typeof ShellStateSchema>;

/**
 * The served shell, pushed when a build rewrites it: the popup compares its
 * own `shellDigest` with it and reloads the extension when they differ.
 */
export const browserExtensionShell = liveValue("browser-extension.shell", {
  schema: ShellStateSchema,
  needsMachine: NEEDS_MACHINE,
});

/**
 * Whether the extension was ever opened on this namespace, and when last —
 * only the popup knows it is connected, so it records each open.
 */
export const ConnectionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }),
  z.object({
    kind: z.literal("seen"),
    /** When the popup last opened (epoch ms). */
    seenAt: z.number(),
    /** The shell digest that popup ran. */
    shellDigest: z.string(),
  }),
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const browserExtensionConnection = liveValue(
  "browser-extension.connection",
  { schema: ConnectionStateSchema, needsMachine: NEEDS_MACHINE },
);

/** The popup opened, running the shell `shellDigest`. */
export const recordExtensionOpen = defineEndpoint({
  route: "POST /api/browser-extension/connection",
  body: z.object({ shellDigest: z.string().min(1) }),
  needsMachine: NEEDS_MACHINE,
});
