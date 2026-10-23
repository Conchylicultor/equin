import { Icon } from "@plugins/ui/plugins/icons/web";
import { type ReactNode, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  SortableList,
  SortableItem,
} from "@plugins/primitives/plugins/sortable-list/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "../internal/resolve-instances";
import type { ViewActionsCore } from "../internal/use-view-model";
import { ViewSettingsPopover } from "./view-settings-popover";
import { AddViewMenuItems } from "./add-view-menu-items";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");

/**
 * Config-mode switcher: drag-reorderable ghost chips (matching the read-only
 * `SegmentedControl variant="ghost"` look so chrome stays identical) + a trailing,
 * always-visible `+` add menu. Click an inactive chip → select; click the **active** chip → open
 * its settings popover (rename / options sub-form / duplicate / delete).
 */
export function EditableViewSwitcher<T extends ViewTypeMeta>({
  instances,
  activeId,
  onSelect,
  actions,
}: {
  instances: ResolvedViewInstance<T>[];
  activeId: string;
  onSelect: (id: string) => void;
  actions: ViewActionsCore;
}): ReactNode {
  // WHICH view's settings are open, not merely whether some are: a bare boolean
  // stayed true when the active instance changed under it, so the panel silently
  // re-aimed at a different view and the next click in it edited that one.
  const [settingsForId, setSettingsForId] = useState<string | null>(null);
  const ids = instances.map((r) => r.instance.id);

  const onMove = (movedId: string, overId: string) => {
    const overIndex = ids.indexOf(overId);
    if (overIndex < 0) return;
    actions.reorderView(movedId, overIndex);
  };

  return (
    // Hugs its chips: the chips keep their content floor and never truncate —
    // the host (the toolbar's views pill) scrolls the strip sideways when it
    // runs out of room.
    <Stack direction="row" align="center" gap="xs">
      <SortableList items={ids} onMove={onMove} orientation="horizontal">
        <Stack direction="row" align="center" gap="xs">
          {instances.map((r) => {
            const icon = r.instance.icon;
            const id = r.instance.id;
            const isActive = id === activeId;
            const chip = (
              <ToggleChip
                active={isActive}
                variant="ghost"
                icon={<Icon icon={icon} />}
                tooltip={r.instance.name}
                // Which view type the chip opens — what a script driving the
                // surface picks a view by (`data-view/e2e/live-pages-scroll.ts
                // --view`), whatever the instance is named.
                data-view-type={r.instance.type}
                onClick={() => {
                  if (isActive) {
                    setSettingsForId((open) => (open === id ? null : id));
                  } else {
                    setSettingsForId(null);
                    onSelect(id);
                  }
                }}
              >
                {r.instance.name}
              </ToggleChip>
            );
            return (
              <SortableItem key={id} id={id}>
                {() =>
                  isActive ? (
                    <ControlPanelPopover
                      open={settingsForId === id}
                      onOpenChange={(open) =>
                        setSettingsForId(open ? id : null)
                      }
                      align="start"
                      trigger={chip}
                      label={`${r.instance.name} settings`}
                    >
                      <ViewSettingsPopover
                        instance={r}
                        actions={actions}
                        onClose={() => setSettingsForId(null)}
                      />
                    </ControlPanelPopover>
                  ) : (
                    chip
                  )
                }
              </SortableItem>
            );
          })}
        </Stack>
      </SortableList>

      {/* The `+` add-view button, always visible: adding a view is a first-class
          gesture, not chrome to discover by hovering. Ambient size comes from
          the surrounding `ControlSizeProvider`, with `IconButton` itself as the
          trigger's `render` target (mirroring CreatorsControl) — a provider as
          the render root would swallow base-ui's trigger wiring. */}
      <ControlSizeProvider size="sm">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                icon={addIcon}
                label="Add view"
                className="text-faint-foreground hover:text-foreground"
              />
            }
          />
          <DropdownMenuContent align="start">
            <AddViewMenuItems actions={actions} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ControlSizeProvider>
    </Stack>
  );
}
