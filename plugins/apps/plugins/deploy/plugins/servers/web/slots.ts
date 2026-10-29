import type { ComponentType } from "react";
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { Server } from "../shared";

/**
 * Which of the page's two columns a section sits in: the wide `main` column, or
 * the narrow `side` rail of facts about the server. REQUIRED on every
 * contribution — a section with no column would have no place on the page.
 */
export type ServerDetailColumn = "main" | "side";

/**
 * The server detail pane: **one slot whose sections are contributions**, hosted
 * by `serverDetailPane`. The host owns every card, so the pane's regions are
 * uniform by construction.
 *
 * It is owned by `servers` rather than by the app shell because its props are a
 * `Server` — a pane about one row of this plugin's table was never an app-level
 * concern. The whole row is passed (not a `serverId`) because the pane already
 * has it in hand; re-deriving it per section would be a needless resource read
 * per card, and a section that only needs the id reads `server.id`.
 *
 * This replaced three slots (`Deploy.Section`, `Servers.SshSetup`,
 * `Servers.DetailHeader`) and a hardcoded form. Two of those were
 * single-contributor micro-slots that existed only because the identity form was
 * not itself a contribution; once it is, they collapse into peers of it.
 */
export const ServerDetail = defineDetailSections<
  { server: Server },
  { column: ServerDetailColumn }
>();

/** A piece of the server page's header, handed the open server. */
export interface ServerHeaderPart {
  component: ComponentType<{ server: Server }>;
}

/**
 * The server page's header: the server's identity (mark, name, address) is
 * `servers`' own, and everything else about it is a contribution — `health`
 * adds the status pill beside the name, the platform to the meta line and
 * "Check now" to the actions (`servers` cannot import `health`).
 */
export const ServerHeader = {
  /** Beside the server's name (the status pill). */
  Badge: defineRenderSlot<ServerHeaderPart>({ docLabel: (p) => p.id }),
  /** After the address on the meta line (platform, console link). */
  Meta: defineRenderSlot<ServerHeaderPart>({ docLabel: (p) => p.id }),
  /** The header's buttons, trailing. */
  Action: defineRenderSlot<ServerHeaderPart>({ docLabel: (p) => p.id }),
};
