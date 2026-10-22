import type { ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import {
  isBuiltInThemeId,
  type Theme,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  useRemoveSavedTheme,
  type RemoveSavedTheme,
} from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/web";
import type { ThemeRow } from "../internal/theme-rows";
import { useScopeLabel } from "../internal/use-theme-gallery";
import { RenameThemeDialog } from "./rename-theme-dialog";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");
const driveFileRenameIcon = symbol("drive-file-rename");

/** Trailing-action slot for the Theme DataView's rows (the customizer pane's). */
export const ThemeItemActions = defineItemActions<ThemeRow>();

/** "Desktop", "Desktop and Mail", "Desktop, Mail and Pages". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What deleting does to the scopes that select the theme, in a sentence. */
function fallbackSentence(scopeNames: readonly string[]): string {
  if (scopeNames.length === 0)
    return "Neither the desktop nor any app uses it.";
  const verb = scopeNames.length === 1 ? "uses" : "use";
  return `${joinNames(scopeNames)} ${verb} it and will switch to the Default theme.`;
}

/**
 * Ask, then delete. The confirm names every scope that will fall back to
 * Default; confirming deletes with `reassign` whenever it named any, since
 * that is what the user just agreed to.
 *
 * The server can still know of a scope this page does not (an app this
 * composition does not include). Then the delete comes back "in use" with the
 * server's own list, and the user is asked again, naming those scopes.
 * `removeSavedTheme` is the row's (bound to its subtree's transport).
 */
function confirmDelete(
  removeSavedTheme: RemoveSavedTheme,
  theme: Theme,
  scopeNames: readonly string[],
  scopeLabel: (scopeId: string | undefined) => string,
): void {
  void confirmDialog({
    title: `Delete “${theme.label}”?`,
    description: fallbackSentence(scopeNames),
    confirmLabel: "Delete",
    onConfirm: async () => {
      const result = await removeSavedTheme(theme.id, {
        reassign: scopeNames.length > 0,
      });
      if (result.kind === "in-use") {
        confirmDelete(
          removeSavedTheme,
          theme,
          result.usedBy.map((u) => scopeLabel(u.scopeId)),
          scopeLabel,
        );
      }
    },
  });
}

/**
 * Delete a saved theme (a custom theme or a tweakcn import). Code themes get no
 * button at all rather than a disabled one: they are part of the app, and
 * deleting one is not a thing that becomes available later.
 */
export function DeleteThemeAction({
  row,
}: ItemActionProps<ThemeRow>): ReactElement | null {
  const scopeLabel = useScopeLabel();
  const removeSavedTheme = useRemoveSavedTheme();
  const { target } = row;
  if (target.kind !== "resident" || isBuiltInThemeId(target.theme.id)) {
    return null;
  }
  const { theme } = target;
  return (
    <IconButton
      icon={deleteIcon}
      label="Delete theme"
      onClick={(e) => {
        e.stopPropagation();
        confirmDelete(
          removeSavedTheme,
          theme,
          row.usedBy.map((u) => u.label),
          scopeLabel,
        );
      }}
    />
  );
}

/**
 * Rename one of the user's own themes. Only custom themes: a tweakcn import
 * keeps the name it has in the catalog, and the server refuses to rename one.
 */
export function RenameThemeAction({
  row,
}: ItemActionProps<ThemeRow>): ReactElement | null {
  const { target } = row;
  if (target.kind !== "resident" || target.theme.source !== "custom") {
    return null;
  }
  const { theme } = target;
  return (
    <IconButton
      icon={driveFileRenameIcon}
      label="Rename theme"
      onClick={(e) => {
        e.stopPropagation();
        void openDialog(
          (close) => <RenameThemeDialog theme={theme} onClose={close} />,
          { size: "sm" },
        );
      }}
    />
  );
}
