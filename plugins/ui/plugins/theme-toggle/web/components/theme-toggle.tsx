import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useColorModeSetting,
  useResolvedColorMode,
} from "@plugins/ui/plugins/theme-engine/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const darkModeIcon = symbol("dark-mode");
const systemIcon = symbol("contrast");

/**
 * Light/dark as two switches inside the theme popover, rather than a second
 * toolbar button beside the palette one. Both controls answered the same
 * question ("how should this look?"), and the popover is where that question is
 * already being answered — a theme swatch and the scheme it is painted in
 * belong on one surface.
 *
 * Both edit the scheme of the scope this document wears — the focused app's
 * (its per-app override), or the global setting when no single app fills the
 * surface — through theme-engine's hooks, which name that scope once. This
 * control used to pick the scope itself and wrote one the class never read.
 *
 * "Dark mode" reads the RESOLVED mode (`system` collapsed against the OS, live),
 * which is what the class applier uses — so it always describes the scheme on
 * screen, and one click flips it (to an explicit light / dark, leaving `system`).
 * "Match system" is on while the effective setting is `system`.
 *
 * Until the surface has said which app owns the document, which scope the
 * switches would read and write is unknown: they render a loading state rather
 * than the desktop's setting.
 *
 * `select="switch"` puts the indicator in the row's TRAILING cell, so the
 * leading icon costs the panel nothing it was not already paying: the footer's
 * ⚙ has the icon column open regardless.
 */
export function ThemeToggle() {
  const dark = useResolvedColorMode() === "dark";
  const root = useColorModeSetting();
  if (!root.known) return <Loading variant="rows" count={2} />;
  const { setting, setColorMode } = root;
  const following = setting.effective === "system";

  return (
    <>
      <ControlPanel.Row
        icon={<Icon icon={darkModeIcon} />}
        select="switch"
        checked={dark}
        hint={scopeHint(setting.app?.id)}
        onSelect={() => setColorMode(dark ? "light" : "dark")}
      >
        Dark mode
      </ControlPanel.Row>
      <ControlPanel.Row
        icon={<Icon icon={systemIcon} />}
        select="switch"
        checked={following}
        hint="Follow the light or dark appearance of your computer."
        onSelect={() =>
          setColorMode(following ? (dark ? "dark" : "light") : "system")
        }
      >
        Match system
      </ControlPanel.Row>
    </>
  );
}

function scopeHint(appId: string | undefined): string {
  return appId === undefined
    ? "The default for every app that follows it."
    : "For this app. The theme editor sets the default for every app.";
}
