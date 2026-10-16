import { createContext, useContext, useMemo, type ReactNode } from "react";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  Apps,
  useHomeApp,
  useActiveApp,
  type ActiveApp,
} from "@plugins/apps-core/web";
import { isNodeData, useReorderedEntries } from "@plugins/reorder/web";
import {
  useActivateApp,
  useAppLinkProps,
} from "@plugins/apps-core/plugins/tabs/web";
import { AppIconView } from "@plugins/apps-core/plugins/app-icon/web";
import {
  appRow,
  appRowOverrides,
  type AppRow,
} from "../internal/installed-app";
import { installedApp } from "../../core";
import { HoverPopover } from "@plugins/primitives/plugins/overlay/plugins/hover-popover/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PopupTheme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { AppShellBrandForm } from "@plugins/primitives/plugins/app-shell/web";

const allAppsIcon = symbol("apps");

const LAUNCHER_VIEW = defineDataView("apps-core.launcher");

/** The popover's footer link ("All apps"), handed to the hosted frame — a
 *  frame is a module-level component, so what it needs from this render
 *  arrives by context. */
const FooterContext = createContext<ReactNode>(null);

/**
 * The popover is the DataView's frame: no toolbar band, just the grid, then a
 * footer line with "All apps" and — revealed on hover — the options trigger
 * (search: type to narrow the grid).
 */
function LauncherFrame({ body, options }: HostedToolbarParts) {
  const footer = useContext(FooterContext);
  return (
    <Stack gap="xs">
      {body}
      <Line className="border-t pt-xs">
        {footer}
        <Fill />
        {options}
      </Line>
    </Stack>
  );
}

const LAUNCHER_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: LauncherFrame,
};

/**
 * Every installed app but the gallery, in the order the app rail shows them
 * (the `Apps.App` slot's reorder config, read through the same tree its
 * `Render` applies — so the two cannot disagree), apps the user hid included
 * in neither. Layout nodes (spacers, dividers) are the rail's, not apps.
 */
function useLaunchableApps(galleryId: string | undefined): ActiveApp[] {
  const apps = Apps.App.useContributions();
  // The contributions carry `_pluginId` + `id`, all the reorder key needs; they
  // lack `_slot`, so widen through `unknown`.
  const { entries } = useReorderedEntries(
    Apps.App.id,
    apps as unknown as Contribution[],
  );
  return useMemo(
    () =>
      entries
        .filter((e) => !isNodeData(e))
        .map((e) => e as unknown as ActiveApp)
        .filter((a) => a.id !== galleryId),
    [entries, galleryId],
  );
}

/**
 * The launcher button's face: the current app's own mark — its drawn logo when
 * it registers one (`mark`), else its rail glyph — so every app keeps its
 * identity at the top-left. Outside any app, the Equin mark.
 */
function LauncherMark({
  app,
  className,
}: {
  app: ActiveApp | undefined;
  className: string;
}) {
  if (!app) return <img src="/icon.svg" alt="" className={className} />;
  if (app.mark) return <app.mark className={className} />;
  return <AppIconView icon={app.icon} className={className} />;
}

/**
 * The launcher: the current app's mark as an icon button. A click goes to the
 * deployed composition's home app (`useHomeApp` — declared by the composition's
 * manifest, never named here; on main, the app gallery) — and hovering it (or ArrowDown) reveals every other installed app as
 * the compact icons DataView (the tile Home draws), the current one marked as
 * the selected row. Picking a tile switches app exactly as the rail does
 * (`useActivateApp`).
 *
 * The button is drawn in the app it sits in, but the grid it opens is the
 * chrome (`PopupTheme`): switching apps belongs to the frame, so the grid looks
 * the same from every app — and the same as the action bar's popovers.
 */
export function AppLauncher({ form }: { form: AppShellBrandForm }) {
  const home = useHomeApp();
  const gallery = home.kind === "app" ? home.app : undefined;
  const launchable = useLaunchableApps(gallery?.id);
  const rows = useMemo(() => launchable.map(appRow), [launchable]);
  const active = useActiveApp();
  const activeId = active?.id;
  const activate = useActivateApp();
  const appLinkProps = useAppLinkProps();
  // No home app registered: nothing to launch, and nowhere to go.
  if (!gallery) return null;
  const galleryLink = appLinkProps(gallery.app.basePath);

  return (
    <PopupTheme name={chromeThemeScope}>
      <HoverPopover
        label="Apps"
        side="bottom"
        align="start"
        width="picker"
        padding="sm"
        trigger={
          <Button
            variant="ghost"
            aspect="icon"
            aria-label="All apps"
            {...galleryLink}
            className="aria-expanded:bg-hover-fill"
          >
            <LauncherMark
              app={active}
              className={cn(
                form === "header" ? "size-sidebar-brand-mark" : "size-5",
                "transition-transform duration-200 ease-[cubic-bezier(.34,1.56,.64,1)] motion-safe:group-hover/button:scale-110 motion-safe:group-aria-expanded/button:scale-110 motion-safe:group-active/button:scale-95",
              )}
            />
          </Button>
        }
        content={({ close }) => (
          <FooterContext.Provider
            value={
              <Button
                variant="ghost"
                {...galleryLink}
                onClick={(e) => {
                  close();
                  galleryLink.onClick(e);
                }}
              >
                <Icon icon={allAppsIcon} />
                All apps
              </Button>
            }
          >
            <DataView<AppRow>
              rows={rows}
              rowKey={(a) => a.id}
              collection={installedApp}
              overrides={appRowOverrides}
              views={["icons"]}
              defaultView="icons"
              density="compact"
              toolbar={LAUNCHER_TOOLBAR}
              searchPlaceholder="Search apps"
              storageKey={LAUNCHER_VIEW}
              selectedRowId={activeId}
              rowActivation={(row) => afterOpen(activate(row.entry), close)}
              emptyState="No app matches."
            />
          </FooterContext.Provider>
        )}
      />
    </PopupTheme>
  );
}
