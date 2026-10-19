import {
  getConfig,
  getConfigScopeIds,
  onConfigDirChange,
} from "@plugins/config_v2/server";
import {
  DocumentHead,
  type HeadFragments,
} from "@plugins/shell/plugins/document-head/server";
import {
  COLOR_MODE_SCOPE_ID,
  themeSelectionConfig,
  type Theme,
  type ThemeId,
} from "../../core";
import {
  apps,
  codeThemes,
  fixedThemes,
  subThemes,
  tokenGroups,
} from "./theme-declarations.generated";
import { ThemeEngine } from "./source";
import { renderThemeHead } from "./theme-head";

/** Every theme that can be painted now: the code themes plus every source's. */
async function themesById(): Promise<Map<ThemeId, Theme>> {
  const stored = await Promise.all(
    ThemeEngine.Source.getContributions().map((s) => s.list()),
  );
  const byId = new Map<ThemeId, Theme>();
  for (const theme of [...codeThemes, ...stored.flat()]) {
    if (byId.has(theme.id)) {
      throw new Error(
        `[theme-engine] two themes claim the id "${theme.id}" — theme ids must be unique across code themes and every ThemeEngine.Source.`,
      );
    }
    byId.set(theme.id, theme);
  }
  return byId;
}

async function render(): Promise<HeadFragments> {
  const scopes = getConfigScopeIds(themeSelectionConfig).map((scopeId) => ({
    scopeId,
    themeId: getConfig(themeSelectionConfig, scopeId).theme,
  }));
  return renderThemeHead(
    {
      groups: tokenGroups,
      themesById: await themesById(),
      subThemes,
      fixedThemes,
    },
    apps,
    {
      baseThemeId: getConfig(themeSelectionConfig).theme,
      colorMode: getConfig(themeSelectionConfig, COLOR_MODE_SCOPE_ID)
        .colorMode as "light" | "dark" | "system",
      scopes,
    },
  );
}

/**
 * Changes to what `render` reads: any theme selection document — written,
 * created or removed, in-process or by hand; the config dir's change signal
 * covers all of them, a new app scope included — and every theme source.
 */
function subscribe(onChange: () => void): () => void {
  const unsubscribes = [
    onConfigDirChange(onChange),
    ...ThemeEngine.Source.getContributions().map((s) => s.subscribe(onChange)),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** The first frame's theme CSS, served in the SPA shell's head. */
export const themeDocumentHead = DocumentHead.Fragment({
  id: "theme-engine",
  render,
  subscribe,
});
