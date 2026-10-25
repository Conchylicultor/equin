import { Icon } from "@plugins/ui/plugins/icons/web";
import { type CSSProperties, type ReactNode, useState } from "react";
import {
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  ControlSizeProvider,
  Separator,
  useControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  rolePickClass,
  rolePickScope,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
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
import {
  type HostViewSettings,
  ViewSettingsPopover,
} from "./view-settings-popover";
import { AddViewMenuItems } from "./add-view-menu-items";
import { symbol } from "@plugins/ui/plugins/icons/core";

const addIcon = symbol("add");

// ── The view chip's look, from the data-view token group ──────────────────
// The defaults draw the ghost chip with its icon and name, the active one on a
// soft neutral fill (`viewChipActiveFill`, a 7% foreground tint) in the
// foreground ink, on soft 7px corners. The `data-part` names are
// DataView parts (`DATA_VIEW_PARTS`, data-view core) spelled literally: this
// plugin sits under data-view's core, which already imports it.

/** The active chip's fill, ink and ring (a soft neutral fill / the
 *  foreground / transparent by default). The ring is inset: a hairline inside
 *  the chip's box, so a ringed chip is no larger. */
const ACTIVE_CHIP_CLASS =
  "bg-view-chip-active-fill text-view-chip-active-ink ring-1 ring-inset ring-view-chip-active-ring";

/**
 * The active chip's inline padding: the theme's `viewChipActivePadStart/End`,
 * else (unset) the `md` chip's own `px-control-sm` sides — so unset it is
 * that padding exactly. Inline, because an unset token must fall back to the
 * chip's own expression, which only a `var()` fallback can say.
 */
const ACTIVE_CHIP_PAD: CSSProperties = {
  paddingInlineStart:
    "var(--view-chip-active-pad-start, calc(var(--control-pad-sm) + var(--pill-extra-start)))",
  paddingInlineEnd:
    "var(--view-chip-active-pad-end, calc(var(--control-pad-sm) + var(--pill-extra-end)))",
};

/** `viewChipIcon: never` hides every chip's icon (`always` by default). */
const CHIP_ICON_CLASS = "[@container_style(--view-chip-icon:never)]:hidden";

/**
 * The `md` chip's glyph size and glyph↔name gap (`viewChipIconSize` /
 * `viewChipGap`) and corners (`viewChipRadius`); defaults the chip's own
 * `icon-auto`, `gap-control-sm` and `rounded-full`.
 */
const MD_CHIP_ICON_CLASS = "size-view-chip-icon";
const MD_CHIP_GAP_CLASS = "gap-view-chip rounded-view-chip";

/**
 * `viewChipLabel: active` hides an inactive chip's name (`always` by
 * default): the label goes, and the chip's icon/label gap with it (the empty
 * label box would otherwise still hold the gap open).
 */
const INACTIVE_LABEL_HIDE_CLASS =
  "[@container_style(--view-chip-label:active)]:hidden";
const INACTIVE_CHIP_GAP_CLASS =
  "[@container_style(--view-chip-label:active)]:gap-none";

/** The strip the add-view button reveals with (`viewAddReveal: hover`). */
const VIEW_STRIP_GROUP = "group/view-strip";

/**
 * `viewAddReveal: hover` (the default) shows the add-view button only while
 * the strip is pointed at, the button holds keyboard focus, or its menu is
 * open; `always` keeps it at rest. Opacity only: hidden, it still takes its
 * place in the strip (no reflow on reveal) and stays in the tab order — a
 * keyboard user tabbing to it sees it.
 */
const ADD_REVEAL_CLASS =
  "transition-opacity [@container_style(--view-add-reveal:hover)]:group-[:not(:hover)]/view-strip:not-focus-visible:not-data-popup-open:opacity-0";

/** `viewAddSeparator: show` draws a rule before the add-view button
 *  (`hide` by default), boxed like the toolbar's pill divider. */
const ADD_SEPARATOR_CLASS =
  "[@container_style(--view-add-separator:hide)]:hidden h-pill-divider px-pill-divider";

/**
 * A chip's name. At the `md` chip size (every toolbar: `sm` density) it takes
 * the type the theme picks (`DATA_VIEW_PICKS.viewChip`, default the chip's
 * caption at the chip's weight); at the compact `sm` chip (`xs` density, a
 * `text-2xs` chip) it inherits as before. Spelled with `rolePickScope` /
 * `rolePickClass` rather than `<Text pick>`, which in a single-line row would
 * add a native `title` beside the chip's own tooltip.
 */
function ChipLabel(props: {
  picked: boolean;
  hideClass: string | undefined;
  children: ReactNode;
}): ReactNode {
  const pick = DATA_VIEW_PICKS.viewChip;
  return props.picked ? (
    <span
      className={cn("contents", props.hideClass)}
      style={rolePickScope(pick)}
    >
      <span className={rolePickClass(pick.fallback)}>{props.children}</span>
    </span>
  ) : (
    <span className={cn("contents", props.hideClass)}>{props.children}</span>
  );
}

/**
 * Config-mode switcher: drag-reorderable ghost chips (matching the read-only
 * `SegmentedControl variant="ghost"` look so chrome stays identical) + a trailing
 * `+` add menu, revealed with the strip (`viewAddReveal`). Click an inactive chip → select; click the **active** chip → open
 * its settings popover (rename / options sub-form / duplicate / delete).
 */
export function EditableViewSwitcher<T extends ViewTypeMeta>({
  instances,
  activeId,
  onSelect,
  actions,
  hostSettings,
}: {
  instances: ResolvedViewInstance<T>[];
  activeId: string;
  onSelect: (id: string) => void;
  actions: ViewActionsCore;
  /** The consumer's own per-instance settings (see `ViewSettingsPopover`). */
  hostSettings?: HostViewSettings<T>;
}): ReactNode {
  // WHICH view's settings are open, not merely whether some are: a bare boolean
  // stayed true when the active instance changed under it, so the panel silently
  // re-aimed at a different view and the next click in it edited that one.
  const [settingsForId, setSettingsForId] = useState<string | null>(null);
  const ids = instances.map((r) => r.instance.id);
  // The chip is `md` (control-sm, px-control-sm, text-caption) at every
  // density but `xs` — see `ToggleChip`'s `chipSizeForDensity`.
  const mdChip = useControlSize() !== "xs";

  const onMove = (movedId: string, overId: string) => {
    const overIndex = ids.indexOf(overId);
    if (overIndex < 0) return;
    actions.reorderView(movedId, overIndex);
  };

  return (
    // Hugs its chips: the chips keep their content floor and never truncate —
    // the host (the toolbar's views pill) scrolls the strip sideways when it
    // runs out of room.
    <Stack
      direction="row"
      align="center"
      gap="xs"
      className={cn("gap-view-switcher", VIEW_STRIP_GROUP)}
    >
      <SortableList items={ids} onMove={onMove} orientation="horizontal">
        <Stack
          direction="row"
          align="center"
          gap="xs"
          className="gap-view-chips"
        >
          {instances.map((r) => {
            const icon = r.instance.icon;
            const id = r.instance.id;
            const isActive = id === activeId;
            const chip = (
              <ToggleChip
                active={isActive}
                variant="ghost"
                icon={
                  <Icon
                    icon={icon}
                    className={cn(
                      CHIP_ICON_CLASS,
                      mdChip && MD_CHIP_ICON_CLASS,
                    )}
                  />
                }
                tooltip={r.instance.name}
                // The name, also when the theme draws inactive chips icon-only.
                aria-label={r.instance.name}
                data-part={isActive ? "dv.view-chip-active" : "dv.view-chip"}
                className={cn(
                  // Top-aligned in its sortable wrapper's line, not on the
                  // baseline: an icon-only chip (`viewChipLabel: active`) has
                  // no text baseline, so `align-baseline` seated it on the
                  // line's strut and grew the pill by the strut's descent. A
                  // labelled `md` chip, taller than the strut, lands where it
                  // did (the compact chip keeps its baseline seat).
                  mdChip && ["align-top", MD_CHIP_GAP_CLASS],
                  isActive ? ACTIVE_CHIP_CLASS : INACTIVE_CHIP_GAP_CLASS,
                )}
                {...(isActive && mdChip ? { style: ACTIVE_CHIP_PAD } : {})}
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
                <ChipLabel
                  picked={mdChip}
                  hideClass={isActive ? undefined : INACTIVE_LABEL_HIDE_CLASS}
                >
                  {r.instance.name}
                </ChipLabel>
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
                        hostSettings={hostSettings}
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

      {/* The `+` add-view button — revealed with the strip by default
          (`ADD_REVEAL_CLASS`), always tabbable. Ambient size comes from
          the surrounding `ControlSizeProvider`, with `IconButton` itself as the
          trigger's `render` target (mirroring CreatorsControl) — a provider as
          the render root would swallow base-ui's trigger wiring. */}
      <Center
        axis="horizontal"
        aria-hidden
        data-part="dv.pill-divider"
        className={cn(ADD_SEPARATOR_CLASS, rigidClass())}
      >
        <Separator orientation="vertical" className="bg-pill-divider-ink" />
      </Center>
      <ControlSizeProvider size="sm">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                icon={addIcon}
                label="Add view"
                data-part="dv.view-add"
                className={cn(
                  "text-faint-foreground hover:text-foreground [@container_not_style(--view-add-radius:initial)]:rounded-view-add",
                  ADD_REVEAL_CLASS,
                )}
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
