import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { ProfileSettings } from "./components/profile-pane";

// /settings/profile: who the user is (Developer mode).
export const profilePane = Pane.define({
  route: defineRoute({ id: "settings-profile", segment: "profile" }),
  app: settingsApp,
  component: ProfileBody,
  title: "Profile",
  width: 420,
});

function ProfileBody() {
  return (
    <PaneChrome pane={profilePane}>
      <ProfileSettings />
    </PaneChrome>
  );
}
