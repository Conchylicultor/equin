import { Bar } from "@plugins/primitives/plugins/bar/web";
import { AppShellBrand } from "@plugins/primitives/plugins/app-shell/web";
import {
  Clip,
  clipClasses,
} from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Browser } from "../slots";
import { BrowserTabsStore } from "../nav-store";
import "./browser-layout.css";

/**
 * Inner layout — sits INSIDE `<BrowserTabsStore.Provider>` so its children (the
 * tab strip, chrome bars, sub-bar, viewport, effects) can read the per-surface
 * tab store.
 *
 * Chrome's arrangement, top to bottom:
 *
 * - the **tab row** — the app launcher (the shared app-shell brand, at the
 *   leading edge every app shows it) then the contributed tab strip, on the
 *   recessed chrome colour. It is the surface's top line, so it is the floating
 *   action bar's band (`pr-floating-bar anchor-floating-bar-band`).
 * - the **chrome block** — the toolbar (nav controls, the flexible omnibox in
 *   the truncating fill track, the trailing actions) and the sub-bar (bookmarks),
 *   on the content colour so the active tab flows into it, with ONE hairline
 *   under the whole block rather than one per bar.
 * - the viewport.
 */
function BrowserInner() {
  return (
    <Stack
      gap="none"
      className={cn(
        "h-full bg-background",
        clipClasses({ axis: "both", fill: false }),
      )}
    >
      <Line
        className={cn(
          "browser-tab-row pr-floating-bar anchor-floating-bar-band",
          rigidClass(),
        )}
      >
        <span className={cn("browser-tab-launcher", rigidClass())}>
          <ControlSizeProvider size="sm">
            <AppShellBrand form="icon" />
          </ControlSizeProvider>
        </span>
        <Fill>
          <Browser.TabStrip.Render />
        </Fill>
      </Line>
      <Stack gap="none" className={cn("border-b", rigidClass())}>
        <Bar
          tier="chrome"
          endSafeArea={false}
          className="border-b-0 px-chrome text-muted-foreground"
        >
          <Line className="w-full gap-xs">
            <Browser.NavControls.Render />
            <Fill>
              <Browser.Omnibox.Render />
            </Fill>
            <Stack
              direction="row"
              gap="xs"
              align="center"
              justify="end"
              className={rigidClass()}
            >
              <Browser.Actions.Render />
            </Stack>
          </Line>
        </Bar>
        <Browser.SubBar.Render />
      </Stack>
      <Clip as="main" fill>
        <Browser.Viewport.Render />
      </Clip>
      <Browser.Effects.Mount />
    </Stack>
  );
}

/**
 * The browser app layout. Mounts the per-surface tab store provider; the store
 * is consumed only inside `<BrowserInner/>` (a Provider host cannot read its own
 * store in its body).
 */
export function BrowserLayout() {
  return (
    <BrowserTabsStore.Provider>
      <BrowserInner />
    </BrowserTabsStore.Provider>
  );
}
