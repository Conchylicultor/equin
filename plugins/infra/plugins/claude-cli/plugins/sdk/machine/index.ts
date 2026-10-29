import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  BundledClaudeMissingError,
  bundledClaudeBin,
} from "./internal/bundled-bin";

export default {
  description:
    "Where the Claude Code executable is: bundledClaudeBin() resolves the build the installed Agent SDK ships (its per-platform optional dependency, pinned by bun.lock) — the only Claude Code any session runs; the computer's own install is never used. For a caller that must name the file itself (the sdk runtime's per-conversation hardlink, the in-app sign-in); every other session leaves the path to the SDK.",
} satisfies MachinePluginDefinition;
