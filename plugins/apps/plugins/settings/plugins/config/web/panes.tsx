import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { ConfigNav } from "@plugins/config_v2/plugins/settings/web";

// The Settings app's index pane: bare `/settings` lands on the config nav.
// It renders the same `ConfigNav` as `configNavPane` (segment "config"), so the
// moment a config row is opened — which roots a `configNavPane` + detail chain
// at `/settings/config/...` — the left column is visually unchanged. Keeping
// `configNavPane` segment-bearing (rather than making it the index itself)
// preserves config-detail deep-link reloads, which reconstruct the nav column
// from the URL segment.
export const settingsConfigIndexPane = Pane.define({
  title: "Config",
  route: defineRoute({ id: "settings-config-index", segment: "" }),
  app: settingsApp,
  appIndex: true,
  component: SettingsConfigIndexBody,
});

function SettingsConfigIndexBody() {
  return (
    <PaneChrome pane={settingsConfigIndexPane}>
      <ConfigNav />
    </PaneChrome>
  );
}
