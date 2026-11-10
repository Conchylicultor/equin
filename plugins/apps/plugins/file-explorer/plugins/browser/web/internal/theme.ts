import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { both, defineSubTheme } from "@plugins/ui/plugins/theme-engine/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";

/**
 * The previewed file's page (prototype proto-1790864772-0r54's `.doc`): set
 * in from the pane by 28px above (12px here plus a leading heading's own 16px
 * top margin), 32px at the sides and 48px below, read at
 * 14px on a 1.6 line under a 24px heading. Sizes only — the colours stay the
 * app's. Worn by the preview pane's body; popups opened from it leave it.
 */
export const filesDocumentTheme = defineSubTheme({
  id: "files-document",
  label: "Files document",
  fragments: [
    densityGroup.fragment(
      both({
        documentPadTop: "0.75rem",
        documentPadX: "2rem",
        documentPadBottom: "3rem",
      }),
    ),
    typeScaleGroup.fragment(
      both({
        fontSizeBody: "0.875rem",
        lineHeightBody: "1.4rem",
        fontSizeTitle: "1.5rem",
        lineHeightTitle: "1.875rem",
      }),
    ),
  ],
});

/**
 * Files' own theme scope: what the browser and its preview wear wherever they
 * are drawn — hosted beside a conversation or inside a plugin's detail, they
 * wear Files' theme, not their host's (in Files itself this is the scope they
 * are already in).
 */
export const FILES_SCOPE = appThemeScope(fileExplorerApp.id);
