import { type ReactNode, useRef, useState } from "react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { PopupOpenScope } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "../internal/resolve-instances";
import type { ViewActionsCore } from "../internal/use-view-model";
import {
  type HostViewSettings,
  ViewSettingsPopover,
} from "./view-settings-popover";
import { AddViewMenuItems } from "./add-view-menu-items";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const settingsIcon = symbol("settings");

/**
 * The view switcher folded into ONE chip: the active view's icon and name and a
 * chevron. Clicking it opens a menu of the other views, an "Add view" submenu
 * (the same rows the strip's `+` menu shows — {@link AddViewMenuItems}), and
 * "View settings…", which opens the strip's own `ViewSettingsPopover` hung off
 * the chip.
 *
 * Same inputs as `EditableViewSwitcher`, so a host can build both from one
 * model and let its toolbar arrangement pick. No drag reorder: a chip has no
 * row of views to drag within.
 *
 * The settings panel is positioned against the chip rather than triggered by
 * it: the chip is already the menu's trigger, and one element cannot trigger
 * two popups without one click opening both. So the panel opens only from its
 * menu row.
 *
 * `appearance` picks the trigger's shape, never the menu:
 * - **`chip`** (default) — a secondary pill: icon, name, chevron.
 * - **`row`** — a full-width `Row` for a sidebar list: the view's icon in the
 *   row's lead column, sized and spaced like the sidebar nav icons
 *   (`size-sidebar-icon` / `gap-sidebar-icon`), so the switcher reads as the
 *   list's heading line on the nav's columns; the name in the nav labels'
 *   `label` role at medium weight; and a
 *   chevron that appears only on hover / keyboard focus and while the menu (or
 *   the settings panel) is open.
 */
export function CollapsedViewSwitcher<T extends ViewTypeMeta>({
  instances,
  activeId,
  onSelect,
  actions,
  hostSettings,
  appearance = "chip",
}: {
  instances: ResolvedViewInstance<T>[];
  activeId: string;
  onSelect: (id: string) => void;
  actions: ViewActionsCore;
  /** The consumer's own per-instance settings (see `ViewSettingsPopover`). */
  hostSettings?: HostViewSettings<T>;
  /** The trigger's shape — see above. Default `"chip"`. */
  appearance?: "chip" | "row";
}): ReactNode {
  // The settings panel's anchor: whichever trigger rendered. Written through a
  // callback because the two triggers type their `ref` differently (`Button`
  // is a `<button>`, `Row` an `HTMLElement` it decides the tag of).
  const anchorRef = useRef<HTMLElement | null>(null);
  const setAnchor = (el: HTMLElement | null) => {
    anchorRef.current = el;
  };
  const reveal = useHoverReveal();
  // WHICH view's settings are open (see EditableViewSwitcher): a boolean would
  // silently re-aim an open panel at a different view when the active one changes.
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

  const active =
    instances.find((r) => r.instance.id === activeId) ?? instances[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.instance.icon;
  const others = instances.filter((r) => r.instance.id !== active.instance.id);
  const settingsInstance = settingsForId === active.instance.id ? active : null;

  const label = `View: ${active.instance.name}`;
  const trigger = (popupOpen: boolean) =>
    appearance === "row" ? (
      // `Row` infers a `<button>` from the `onClick` the menu trigger merges
      // in, so the trigger stays a native button (and the row's own focus
      // ring, hover tint and single-line truncation come with it).
      <Row
        ref={setAnchor}
        aria-label={label}
        // `sm`: the row form heads a dense list (a sidebar), so it keeps the
        // list rows' tight padding — at `md` it would read as a heading.
        size="sm"
        // The row form lives in a sidebar, so it sits on the sidebar NAV's
        // columns and type (sidebar-metrics): the nav icon's size, the nav's
        // icon-to-label gap — the view name starts where the nav labels do —
        // and the nav labels' `label` role at medium weight, so the switcher
        // reads as one more line of the sidebar rather than a smaller caption.
        className="gap-sidebar-icon text-label font-medium"
        icon={
          <Icon
            icon={ActiveIcon}
            className={cn(
              "size-sidebar-icon text-muted-foreground",
              rigidClass(),
            )}
          />
        }
        {...reveal.groupProps}
      >
        <Fill>{active.instance.name}</Fill>
        <Icon
          icon={keyboardArrowDownIcon}
          className={cn(
            "text-faint-foreground",
            rigidClass(),
            hoverRevealClass(reveal.revealed || popupOpen),
          )}
        />
      </Row>
    ) : (
      <Button
        ref={setAnchor}
        variant="secondary"
        shape="pill"
        aria-label={label}
      >
        <Icon icon={ActiveIcon} className="text-muted-foreground" />
        {active.instance.name}
        <Icon icon={keyboardArrowDownIcon} className="text-faint-foreground" />
      </Button>
    );

  return (
    // The scope hears every popup opened inside it — the menu and the settings
    // panel — so a row trigger's chevron holds while either is open.
    <PopupOpenScope>
      {(popupOpen) => (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger render={trigger(popupOpen)} />
            <DropdownMenuContent align="start">
              {others.map((r) => {
                return (
                  <DropdownMenuItem
                    key={r.instance.id}
                    onClick={() => {
                      setSettingsForId(null);
                      onSelect(r.instance.id);
                    }}
                  >
                    <Icon icon={r.instance.icon} className="size-4" />
                    {r.instance.name}
                  </DropdownMenuItem>
                );
              })}
              {others.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Icon icon={addIcon} className="size-4" />
                  Add view
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <AddViewMenuItems actions={actions} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                onClick={() => setSettingsForId(active.instance.id)}
              >
                <Icon icon={settingsIcon} className="size-4" />
                View settings…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {settingsInstance ? (
            <ControlPanelPopover
              anchor={anchorRef}
              open
              onOpenChange={(open) => {
                if (!open) setSettingsForId(null);
              }}
              align="start"
              label={`${settingsInstance.instance.name} settings`}
            >
              <ViewSettingsPopover
                instance={settingsInstance}
                actions={actions}
                hostSettings={hostSettings}
                onClose={() => setSettingsForId(null)}
              />
            </ControlPanelPopover>
          ) : null}
        </>
      )}
    </PopupOpenScope>
  );
}
