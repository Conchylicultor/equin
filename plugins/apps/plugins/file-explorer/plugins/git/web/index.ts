import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FileBrowserSlots } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { ClientFields } from "@plugins/network/plugins/live/web";
import { gitFields } from "../core";
import { GitFieldsResolver } from "./components/git-fields";
import { useGitLens } from "./internal/git-lens";
import { gitPresentation } from "./internal/presentation";

export default {
  description:
    "Git awareness for the file explorer: inside a git checkout the tree gains a git status badge (M / A / D / R / C / ?, a dot on a folder holding changes; pending until the status is known) and a Changed vs main filter field (client fields of the file-entry row kind, empty outside a checkout), ignored files hide behind a Show ignored files toggle, and a changed file's preview gets its git context (the Diff tab).",
  contributions: [
    ClientFields.Resolve({
      fields: gitFields,
      component: GitFieldsResolver,
    }),
    gitPresentation,
    FileBrowserSlots.Lens({ id: "git", useLens: useGitLens }),
  ],
} satisfies PluginDefinition;
