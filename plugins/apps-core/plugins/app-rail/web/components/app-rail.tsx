import {
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Apps, useActiveApp } from "@plugins/apps-core/web";
import { AppIconView } from "@plugins/apps-core/plugins/app-icon/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { useActivateApp } from "@plugins/apps-core/plugins/tabs/web";

export function AppRail() {
  // Self-sufficient: the rail derives its own active-app highlight rather than
  // taking it as a prop, so a framing variant can render <AppRail/> with no
  // wiring. Width reads the same `--app-rail-width` var its parent variant sets
  // (single source of truth — no `w-10`-vs-`2.5rem` drift).
  const activeAppId = useActiveApp()?.id;
  const activate = useActivateApp();
  return (
    <Theme
      as={Stack}
      align="center"
      gap="2xs"
      // The rail wears the chrome's fixed theme, the same whichever app is
      // focused — the frame never changes colour when the app inside does.
      name={chromeThemeScope}
      // The chrome frame's tone, the same ground the tab strip above paints, so
      // the rail and the strip read as one L-shaped frame around the app.
      surface="chrome"
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid rail sibling of the flexible body in the framing row; shrink-0 keeps its fixed width
      className="relative z-nav w-(--app-rail-width) shrink-0 border-r py-xs"
    >
      <Apps.App.Render>
        {(entry) => (
          <WithTooltip content={entry.app.name} side="right">
            <Center
              as="button"
              // Icon-only button: the tooltip is invisible to the a11y tree, so
              // the app name must ALSO be the accessible name.
              aria-label={entry.app.name}
              {...activationProps(activate(entry))}
              // Idle apps are dim and step up on hover; the selected app sits
              // one step further (`accent`) in full text colour. Monochrome on
              // purpose: the only accent on screen belongs to the app itself.
              className={cn(
                "relative size-7.5 rounded-md text-muted-foreground transition-colors hover:bg-hover-fill hover:text-foreground",
                entry.id === activeAppId &&
                  "bg-accent text-accent-foreground hover:bg-accent",
              )}
            >
              <AppIconView
                icon={entry.icon}
                active={entry.id === activeAppId}
                className="size-4.5"
              />
              {entry.badge && (
                <Pin to="top-right" offset="xs" decorative>
                  <entry.badge />
                </Pin>
              )}
            </Center>
          </WithTooltip>
        )}
      </Apps.App.Render>
    </Theme>
  );
}
