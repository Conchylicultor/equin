import { useEffect } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  DEFAULT_THEME_ID,
  resolveTheme,
  themeSelectionConfig,
  type ColorAdjustment,
  type Theme,
  type ThemeId,
  type TokenGroupFragment,
} from "@plugins/ui/plugins/theme-engine/core";
import { ThemeEngine, useThemes } from "@plugins/ui/plugins/theme-engine/web";
import {
  applyFragmentEdit,
  createSavedTheme,
  patchSavedThemeColorAdjust,
  patchSavedThemeFragment,
  type FragmentEdit,
} from "../core";
import { useAwaitSavedThemesWrite } from "./await-saved-themes-write";

export interface ThemeEdits {
  /**
   * Write some of one group's tokens. An empty string clears the token, so the
   * value the theme inherits shows again (a token row's Reset).
   */
  setTokens: (
    groupId: string,
    values: { light?: Record<string, string>; dark?: Record<string, string> },
  ) => Promise<void>;
  /** Change part of the color adjustment; the other fields keep their current (possibly inherited) values. */
  setColorAdjust: (patch: Partial<ColorAdjustment>) => Promise<void>;
  /** Replace one group's values with a shortcut's (a "Fill from…" menu). */
  fillFrom: (fragment: TokenGroupFragment) => Promise<void>;
}

type Edit = { fragment: FragmentEdit } | { colorAdjust: ColorAdjustment };

/**
 * The custom copy an edit is creating (or has just created) for a scope, keyed
 * by scope ("" = the desktop), until that scope's selection shows it.
 *
 * A drag (a colour area, a slider) fires many edits before the selection
 * switches to the copy, and every one of them still sees the read-only theme.
 * Without this each would mint its own "<label> copy"; with it they queue
 * behind the first and land on the one copy it made. Module-level because two
 * editors (two sections of one pane) edit the same scope through separate hooks.
 */
const copiesInFlight = new Map<
  string,
  { baseId: ThemeId; copyId: Promise<ThemeId>; settledId?: ThemeId }
>();

/**
 * The one place a theme edit lands, for the scope `scopeId` (undefined = the
 * desktop).
 *
 * Only custom themes are editable. When the scope's theme is a code or tweakcn
 * one, the first edit creates a custom copy (`"<label> copy"`, extending it,
 * already carrying the edit) and selects it for this scope — so an edit never
 * changes a theme other scopes may be showing unless it is already a custom
 * theme of the user's own.
 *
 * Throws when called before the selection and theme list are known, or while
 * the selection failed to load: an editor must not be interactive then.
 */
export function useEditTheme(scopeId: string | undefined): ThemeEdits {
  const themes = useThemes();
  const selection = useConfigResult(themeSelectionConfig, { scopeId });
  const groups = ThemeEngine.TokenGroup.useContributions();
  const selectTheme = useSetConfig(themeSelectionConfig, { scopeId });
  const create = useEndpointMutation(createSavedTheme);
  const patchFragment = useEndpointMutation(patchSavedThemeFragment);
  const patchColorAdjust = useEndpointMutation(patchSavedThemeColorAdjust);
  const awaitSavedThemesWrite = useAwaitSavedThemesWrite();

  // The scope now selects the copy its first edit made: later edits see a
  // custom theme and patch it directly, so the queue entry is done.
  useEffect(() => {
    if (selection.status === "loading" || selection.status === "error") return;
    const key = scopeId ?? "";
    const inFlight = copiesInFlight.get(key);
    if (
      inFlight?.settledId !== undefined &&
      inFlight.settledId === selection.data.theme
    ) {
      copiesInFlight.delete(key);
    }
  }, [scopeId, selection]);

  // The theme the scope currently paints. A selection naming a theme that no
  // longer exists paints Default, so that is what an edit forks from.
  function currentTheme(): {
    theme: Theme;
    themesById: ReadonlyMap<string, Theme>;
  } {
    if (selection.status === "error") {
      // Never fork from the painter's fallback: the copy would be selected
      // over the user's real (unreadable) choice.
      throw new Error(
        `[saved-themes] useEditTheme: an edit arrived while the theme selection failed to load (${selection.error.message}) — the editor must not be interactive then.`,
      );
    }
    if (themes.pending || selection.status === "loading") {
      throw new Error(
        "[saved-themes] useEditTheme: an edit arrived before the theme selection and theme list were known — the editor must not be interactive while they are pending.",
      );
    }
    const { themesById } = themes;
    const theme =
      themesById.get(selection.data.theme) ?? themesById.get(DEFAULT_THEME_ID);
    if (!theme) {
      throw new Error(
        `[saved-themes] useEditTheme: neither the selected theme "${selection.data.theme}" nor "${DEFAULT_THEME_ID}" is registered.`,
      );
    }
    return { theme, themesById };
  }

  // Resolves once the live theme list has the edit (its ack), so an edit's
  // promise settles on what the painter shows.
  async function patch(id: ThemeId, edit: Edit): Promise<void> {
    const { watermark } =
      "fragment" in edit
        ? await patchFragment.mutateAsync({
            params: { id },
            body: edit.fragment,
          })
        : await patchColorAdjust.mutateAsync({
            params: { id },
            body: { colorAdjust: edit.colorAdjust },
          });
    await awaitSavedThemesWrite(watermark);
  }

  async function createCopy(theme: Theme, edit: Edit): Promise<ThemeId> {
    const { theme: copy, watermark } = await create.mutateAsync({
      body: {
        source: "custom",
        label: `${theme.label} copy`,
        extends: theme.id,
        fragments:
          "fragment" in edit ? applyFragmentEdit([], edit.fragment) : [],
        ...("colorAdjust" in edit ? { colorAdjust: edit.colorAdjust } : {}),
      },
    });
    // Wait for the live list to have the copy BEFORE selecting it, so no
    // render sees the scope select a theme its theme list does not have yet.
    await awaitSavedThemesWrite(watermark);
    selectTheme("theme", copy.id);
    return copy.id;
  }

  async function applyEdit(theme: Theme, edit: Edit): Promise<void> {
    if (theme.source === "custom") {
      await patch(theme.id, edit);
      return;
    }

    const key = scopeId ?? "";
    const inFlight = copiesInFlight.get(key);
    if (inFlight && inFlight.baseId === theme.id) {
      await patch(await inFlight.copyId, edit);
      return;
    }

    const entry: {
      baseId: ThemeId;
      copyId: Promise<ThemeId>;
      settledId?: ThemeId;
    } = { baseId: theme.id, copyId: createCopy(theme, edit) };
    copiesInFlight.set(key, entry);
    try {
      entry.settledId = await entry.copyId;
    } catch (err) {
      // No copy exists: the next edit must try again rather than wait on this.
      copiesInFlight.delete(key);
      throw err;
    }
  }

  return {
    setTokens: async (groupId, values) => {
      const { theme } = currentTheme();
      await applyEdit(theme, {
        fragment: {
          groupId,
          mode: "merge",
          light: values.light ?? {},
          dark: values.dark ?? {},
        },
      });
    },
    setColorAdjust: async (patch) => {
      const { theme, themesById } = currentTheme();
      const { colorAdjust } = resolveTheme(
        theme.id,
        themesById,
        groups.map((g) => g.descriptor),
      ).theme;
      await applyEdit(theme, { colorAdjust: { ...colorAdjust, ...patch } });
    },
    fillFrom: async (fragment) => {
      const { theme } = currentTheme();
      await applyEdit(theme, {
        fragment: {
          groupId: fragment.groupId,
          mode: "replace",
          light: definedValues(fragment.light),
          dark: definedValues(fragment.dark),
          ...(fragment.meta === undefined ? {} : { meta: fragment.meta }),
        },
      });
    },
  };
}

function definedValues(
  values: TokenGroupFragment["light"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(values)) {
    if (value !== undefined) out[token] = value;
  }
  return out;
}
