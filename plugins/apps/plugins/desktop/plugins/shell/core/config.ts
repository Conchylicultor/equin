import { defineConfig } from "@plugins/config_v2/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";

/**
 * The desktop's shelf settings. GLOBAL (no `scope: "app"`): the dock belongs to the
 * desktop itself, so the same apps stay pinned in every app and worktree.
 *
 * `pinnedApps` is the dock's pinned apps, by app id, in dock order. They keep
 * an entry with no window open; any other app shows up only while it runs.
 * "Keep in dock" / "Remove from dock" (the shelf's app menu, the launcher)
 * write it. The default is Pages, the Agent Manager and Sonata.
 *
 * Owned by the desktop shell, not the shelf: the shelf and the launcher both
 * read and write it, and the launcher opens from the shelf — a config owned by
 * either one would close an import cycle between them.
 */
export const shelfConfig = defineConfig({
  name: "shelf",
  fields: {
    pinnedApps: stringListField({
      label: "Apps kept in the dock",
      default: ["pages", "agent-manager", "sonata"],
    }),
  },
});
