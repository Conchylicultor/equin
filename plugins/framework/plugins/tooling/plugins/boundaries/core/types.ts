import type {
  PluginFolder,
  RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";

export interface ZoneDefinition {
  name: string;
  match: string;
  discover?: "plugin-tree";
}

export interface AllowEdge {
  kind: "allow";
  source: string;
  target: string;
}

export interface DenyEdge {
  kind: "deny";
  source: string;
  target: string;
}

export type Edge = AllowEdge | DenyEdge;

export type PlatformApiPolicy = "allowed" | "forbidden";

export interface BoundaryConfig {
  zones: ZoneDefinition[];

  /** Which barrel folders each plugin folder can import from. Default-deny:
   *  unlisted = blocked. Exhaustive over `PluginFolder`, so a new folder name
   *  needs a row; the values are `RuntimeFolder`s, so no row can target a leaf. */
  folders: Record<PluginFolder, RuntimeFolder[]>;

  /** Whether each plugin folder may import a platform API (`./platform-apis`).
   *  Exhaustive over `PluginFolder`, so a new folder must decide; read by the
   *  `boundaries/no-platform-api` lint rule. */
  platformApis: Record<PluginFolder, PlatformApiPolicy>;

  /** Specific full-zone pairs that bypass the runtime check. "source.runtime -> target.runtime" */
  runtimeExceptions?: string[];

  /** Zone-level edges (no runtime suffixes). First-match, default-deny. */
  edges: Edge[];

  /** Files excluded from boundary checks (composition roots). */
  exclude?: string[];
}
