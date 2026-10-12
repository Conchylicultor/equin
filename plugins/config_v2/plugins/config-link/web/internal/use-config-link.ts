import { useCallback } from "react";
import { useActiveApp } from "@plugins/apps-core/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { configDetailRoute } from "@plugins/config_v2/plugins/settings/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

// Returns a link builder: a config descriptor → the in-app link to its settings
// section, as a `LinkTarget` (plain click navigates here, ⌘/middle-click opens
// a browser tab). The descriptor is the link: it self-identifies its settings
// location through the existing ConfigV2.WebRegister registry, so no
// per-surface wiring (and no extra registry) is needed — pass the same
// descriptor the surface already reads with useConfig().
//
// This uses the cross-app `navigate()` (through `appLink`) rather than
// `useOpenPane()`: the config gear is baked into reusable picker chrome
// (ConfigSelectContent / ConfigMenuContent / ConfigGearButton) that can render
// OUTSIDE every pane surface — e.g. a preprompt picker inside the Improve
// popover, which mounts in the global action bar. The destination is built from
// a URL the registry already knows. The config chain roots in whichever app is
// focused (its panes are globally registered), mirroring the theme-customizer
// button.
//
// The registry lookup runs when the link is FOLLOWED, not when it is built: a
// gear renders before every deferred-tier registration has loaded, and an
// unregistered descriptor fails loudly at the click that would have gone
// nowhere.
export function useConfigLink(): (descriptor: ConfigDescriptor) => LinkTarget {
  const registrations = useConfigRegistrations();
  const activeApp = useActiveApp();
  return useCallback(
    (descriptor: ConfigDescriptor) => {
      const url = () => {
        const reg = registrations.find((r) => r.descriptor === descriptor);
        if (!reg) {
          throw new Error(
            "useConfigLink: descriptor is not registered via ConfigV2.WebRegister — " +
              "it has no settings section to open.",
          );
        }
        // configDetailRoute chains under configNavRoute, so `.path()` builds
        // the full `/config/cd/<configPath>` app-relative URL; prefix the
        // focused app's base path (root app → "").
        const appBase =
          !activeApp || activeApp.app.basePath === "/"
            ? ""
            : activeApp.app.basePath;
        return (
          appBase +
          configDetailRoute.path({
            configPath: encodeURIComponent(reg.storePath),
          })
        );
      };
      return {
        open: () => appLink(url()).open(),
        href: url,
      };
    },
    [registrations, activeApp],
  );
}
