import {
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { insetClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  LaunchModelMenuContent,
  useLaunchConversation,
} from "@plugins/primitives/plugins/launch/web";
import { choiceLabel } from "@plugins/conversations/plugins/model-provider/core";
import { useDefaultModel } from "@plugins/conversations/plugins/model-provider/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const playArrowIcon = symbol("play-arrow");

/**
 * The new-conversation launch control as a sidebar nav row: a model picker —
 * a bordered, filled box led by an accent dot, its label in the sidebar's
 * emphasised text colour — and, a small gap away, a launch button in the same
 * fill and at the same height. Built from `SidebarMenuButton` chrome so it
 * keeps the nav links' font and icon sizing; its height is the md control's
 * (`--control-height-md`), not the nav row's, because it is a control sitting
 * above the nav rather than one of its links — and it stands a `md` step apart
 * from the first nav row below it. (Rendering
 * `LaunchControl` here would import the page-canvas `Button` density and
 * typography into the nav rail, which is why the composition is local; the
 * launch *behavior* and the model menu still come from the primitive, via
 * `useLaunchConversation` + `LaunchModelMenuContent`.)
 *
 * `Line` is the outer container for its `whitespace-nowrap`: the shadcn
 * `SidebarMenuButton` carries `overflow-hidden` WITHOUT it, so on a narrow rail
 * the label would wrap to a second line and the clip would hide the overflow
 * rather than the wrap (the exact trap `no-clip-without-nowrap` describes).
 */
export function LaunchSidebarItem() {
  const { launch, launching, availability } = useLaunchConversation({});
  const defaultModel = useDefaultModel();
  const label = choiceLabel(defaultModel);

  return (
    <SidebarMenu className={insetClass({ b: "md" })}>
      <SidebarMenuItem>
        <Line className="gap-xs">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  className={cn(
                    fillClasses("x"),
                    "h-(--control-height-md) border border-sidebar-border bg-sidebar-accent font-semibold text-sidebar-accent-foreground",
                  )}
                />
              }
            >
              <StatusDot colorClass="bg-primary" />
              <span>{label}</span>
              <Fill />
              <Icon icon={keyboardArrowDownIcon} className="opacity-60" />
            </DropdownMenuTrigger>
            <LaunchModelMenuContent launch={launch} />
          </DropdownMenu>
          <IconButton
            icon={playArrowIcon}
            label={`Launch ${label}`}
            variant="ghost"
            // No computer behind this subtree (the demo): nothing can launch,
            // and the tooltip says why.
            tooltip={availability.available ? undefined : availability.message}
            disabled={!availability.available || launching !== null}
            onClick={() => launch(defaultModel)}
            // The nav rows' `rounded-md`, in the picker's fill, with the
            // accent on the glyph only. As tall as the picker beside it (the md
            // control height), and as wide: a square.
            className="h-(--control-height-md) w-(--control-height-md) rounded-md bg-sidebar-accent text-primary-text"
          />
        </Line>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
