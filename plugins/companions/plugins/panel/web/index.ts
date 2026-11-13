import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { Companion as CompanionSlots } from "./slots";
import { companionSolidTheme, companionTheme } from "./internal/theme";

export {
  Companion,
  type CompanionSectionProps,
  type CompanionStatus,
} from "./slots";
export { CompanionPanel } from "./components/companion-panel";
export { PanelSection } from "./components/panel-section";
export { CompanionHeader } from "./components/companion-header";
export { CompanionFooter } from "./components/companion-footer";

export default {
  description:
    "The panel every companion draws (the menu-bar tray and the browser extension). CompanionPanel is a companion's whole page — the panel filling its window, its body the host's own section slot passed as `sections` (each companion orders its own), showing no toasts; what only the host can do comes in as props (corner clip style, onContentHeight for a window that fits the content, onAttention for an icon dot or badge, headless children). PanelSection is the one labelled section (a caption title, then its body), so section titles match everywhere. CompanionHeader (the logo and a status line joined from every Companion.Status part, pending until each part is known) and CompanionFooter ('Running · <host>', opening equin through the host's `open`, else a plain link). The companion themes: a native menu's look (system font, 13px rows, a 2–16px spacing ramp, the menu palette) in light and dark, one per window material — `companion` (translucent: light, the panel at 86% over a vibrancy window, the menu bar) and `companion-solid` (an opaque window with nothing to blur, the Chrome popup: light, the solid #e2e6ea panel) — selected per companion app, which declares colorMode 'system' so it follows the OS.",
  contributions: [
    // Selected per companion app in
    // `config/ui/theme-engine/@app/<app>/theme.jsonc`.
    ThemeEngine.Theme(companionTheme),
    ThemeEngine.Theme(companionSolidTheme),
  ],
  slots: CompanionSlots,
} satisfies PluginDefinition;
