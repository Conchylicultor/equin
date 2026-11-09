import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { ConfigNav } from "../components/config-nav";
import { ConfigNavSlots } from "../slots";
import { ConfigDetail } from "../components/config-detail";

// The routes are the single source of truth for the `/config/cd/:configPath`
// segments, and what gives the panes their `.link(app, params)` / `.path(params)`
// builders. Global chrome (e.g. the config gear baked into a picker rendered in
// the action bar) has no pane surface to navigate, so it builds the app-relative
// URL from `configDetailPane` and hands it to the cross-app `navigate()`.
export const configNavRoute = defineRoute({
  id: "config-v2-nav",
  segment: "config",
});

export const configDetailRoute = defineRoute({
  id: "config-v2-detail",
  segment: "cd/:configPath",
  parent: configNavRoute,
});

export const configNavPane = Pane.define({
  title: "Config",
  route: configNavRoute,
  app: settingsApp,
  component: ConfigNavBody,
});

export const configDetailPane = Pane.define({
  title: "Config Detail",
  route: configDetailRoute,
  app: settingsApp,
  component: ConfigDetailBody,
  useResolve: false,
});

function ConfigNavBody() {
  return (
    <PaneChrome pane={configNavPane}>
      <Column
        fill
        className="h-full"
        header={
          <ConfigNavSlots.Notice.Render>
            {(item) => <item.component />}
          </ConfigNavSlots.Notice.Render>
        }
        body={<ConfigNav />}
        scrollBody={false}
      />
    </PaneChrome>
  );
}

function ConfigDetailBody() {
  return (
    <PaneChrome pane={configDetailPane}>
      <ConfigDetail />
    </PaneChrome>
  );
}
