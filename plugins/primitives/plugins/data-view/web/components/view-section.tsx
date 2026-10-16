import { type CSSProperties, type ReactNode, useState } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Sticky,
  stickyOffsetPx,
} from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import {
  CollapsibleContent,
  CollapsibleProvider,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { WithTooltip } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  ViewSettingsPopover,
  type ResolvedViewInstance,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  DATA_VIEW_HEADER_OFFSET_VAR,
  type CreateOption,
  type SectionsToolbarForms,
} from "../../core";
import type { DataViewContribution } from "../slots";
import type {
  SectionPresentation,
  ViewActions,
} from "../internal/use-data-view-model";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "./controls/controls-context";
import { CompactRootPanel } from "./toolbar/compact-controls";
import { useToolbarControls } from "./toolbar/use-toolbar-controls";
import { CreatorsControl } from "./creators-control";

const moreIcon = symbol("more-horiz");
const settingsIcon = symbol("settings");
const addIcon = symbol("add");

/**
 * One view instance of a `{ kind: "sections" }` surface: a collapsible header
 * naming the view, and the view's body under it.
 *
 * **Its own containing block.** Each section is a `Stack` of its own, so its
 * header pins while the section is on screen and hands off to the next
 * section's header as it scrolls away — the per-section sticky of a sidebar,
 * not the accumulating `StickyStack` of group headers (three sidebar headings
 * pinned at once would eat the viewport of the list they head).
 *
 * **The offset it publishes.** The body is a DataView view like any other, and
 * a grouped view pins ITS group headers at `--dv-header-offset`. So the body
 * box re-publishes that variable as this header's measured height: group
 * headers inside a grouped section pin UNDER the section header instead of
 * behind it. The sections shell measures no band, so the header itself pins at
 * the scroller's top.
 *
 * **Header affordances** are the view's own, hover-revealed on the header row
 * (`SectionHeaderRow` → `Row` publishes the `group/row-actions` a nested
 * `RowActions pin={null}` reveals on): `+` is the surface's `creators` already
 * narrowed to this view (`CreateOption.views`), and `⋯` is the view's controls
 * (search + the same per-control rows as the compact fold) plus its instance
 * actions — settings (rename, type/options, duplicate, delete) and "Add
 * section". The cluster reads `⋯` then `+`. The cluster stays visible while that panel is open (the panel is
 * portaled, so the pointer leaves the row) or a search query narrows the view
 * (the `⋯` is how the user finds the query again).
 */
export function ViewSection(props: {
  instance: ResolvedViewInstance<DataViewContribution>;
  presentation: SectionPresentation;
  setCollapsed: (collapsed: boolean) => void;
  header: SectionsToolbarForms["header"];
  /** The surface's creators, already narrowed to this view. */
  creators: CreateOption[] | undefined;
  /** The view's controls context — provided around the `⋯` panel only. */
  controls: DataViewControlsContextValue;
  query: string;
  onQueryChange: (next: string) => void;
  searchPlaceholder: string | undefined;
  actions: ViewActions;
  /** The view's body (or its loading / error state). */
  children: ReactNode;
}): ReactNode {
  const {
    instance,
    presentation,
    setCollapsed,
    header,
    creators,
    controls,
    query,
    onQueryChange,
    searchPlaceholder,
    actions,
    children,
  } = props;
  const [headerRef, { height: headerHeight }] = useElementSize();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const searching = query.length > 0;
  const { description } = presentation;
  const name = instance.instance.name;

  return (
    <Stack gap="none">
      <CollapsibleProvider
        open={!presentation.collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
      >
        <Sticky
          edge="top"
          mask
          layer="nav"
          ref={headerRef}
          // The band pays the rail and the row keeps its own `p-row`, so the
          // label lands on the rows' text column — a caption over the rows, as
          // a quiet group header does. It also takes any section spacing the
          // theme adds beyond the row's own padding, so the row's hover fill
          // covers the label row and not the gap above it.
          className="rail-follow pt-section-head-band pb-section-head-band"
        >
          <SectionHeaderRow
            variant={header}
            disclosure="trailing"
            // The header's block padding is the theme's (density
            // `sectionHeadPad*`, default the row's own `p-row` padding), capped
            // at the row's own here; the excess is the band's (above).
            className="pt-section-head pb-section-head"
            actions={
              <RowActions pin={null} alwaysVisible={optionsOpen || searching}>
                {/* `⋯` first, `+` last: the add sits at the row's very end,
                    where a reader's eye leaves the header for the rows it
                    adds to. */}
                <SectionOptions
                  open={optionsOpen}
                  onOpenChange={setOptionsOpen}
                  controls={controls}
                  query={query}
                  onQueryChange={onQueryChange}
                  searchPlaceholder={searchPlaceholder}
                  instance={instance}
                  actions={actions}
                  description={description}
                />
                {creators && creators.length > 0 ? (
                  <CreatorsControl creators={creators} compact />
                ) : null}
              </RowActions>
            }
          >
            {description ? (
              <WithTooltip content={description}>
                <span>{name}</span>
              </WithTooltip>
            ) : (
              name
            )}
          </SectionHeaderRow>
        </Sticky>
        <CollapsibleContent
          style={
            {
              [DATA_VIEW_HEADER_OFFSET_VAR]: `${stickyOffsetPx(headerHeight)}px`,
            } as CSSProperties
          }
        >
          {children}
        </CollapsibleContent>
      </CollapsibleProvider>
    </Stack>
  );
}

/** The section header's `⋯`: the view's controls and its instance actions. */
function SectionOptions(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controls: DataViewControlsContextValue;
  query: string;
  onQueryChange: (next: string) => void;
  searchPlaceholder: string | undefined;
  instance: ResolvedViewInstance<DataViewContribution>;
  actions: ViewActions;
  description: string | null;
}): ReactNode {
  const { open, onOpenChange, controls } = props;
  return (
    <DataViewControlsProvider {...controls}>
      <ControlPanelPopover
        open={open}
        onOpenChange={onOpenChange}
        align="end"
        // `menu`: the root page is a menu of rows. The filter and sort
        // builders open INSIDE this panel as pages that declare their own
        // `builder` width (`CompactRootPanel`), so the panel widens only while
        // one of them is showing.
        size="menu"
        label="Section options"
        trigger={
          <IconButton icon={moreIcon} label="Section options" variant="ghost" />
        }
      >
        <SectionRootPanel {...props} />
      </ControlPanelPopover>
    </DataViewControlsProvider>
  );
}

/**
 * The `⋯` panel's first page — a component of its own because it reads the
 * panel stack and the controls context, which exist only inside the popover.
 */
function SectionRootPanel(props: {
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (next: string) => void;
  searchPlaceholder: string | undefined;
  instance: ResolvedViewInstance<DataViewContribution>;
  actions: ViewActions;
  description: string | null;
}): ReactNode {
  const {
    onOpenChange,
    query,
    onQueryChange,
    searchPlaceholder = "Search…",
    instance,
    actions,
    description,
  } = props;
  const { controls } = useToolbarControls();
  const close = () => onOpenChange(false);
  return (
    <>
      {description ? (
        <ControlPanel.Section>
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        </ControlPanel.Section>
      ) : null}
      <CompactRootPanel
        controls={controls}
        search={
          <SearchInput
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={searchPlaceholder}
            appearance="menu"
          />
        }
      />
      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={settingsIcon} />}
          push={{
            key: "section-settings",
            title: "Section settings",
            size: "inherit",
            render: () => (
              <ViewSettingsPopover
                instance={instance}
                actions={actions}
                onClose={close}
              />
            ),
          }}
        >
          Section settings
        </ControlPanel.Row>
        <ControlPanel.Row
          icon={<Icon icon={addIcon} />}
          push={{
            key: "add-section",
            title: "Add section",
            size: "inherit",
            render: () => <AddSectionPanel actions={actions} onDone={close} />,
          }}
        >
          Add section
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </>
  );
}

/**
 * "Add section": one row per view type the surface can add — the same
 * `availableSources` the switcher's `+` menu lists. Rows, not
 * `AddViewMenuItems`: those are dropdown-menu items, and this is a panel page.
 * A sections surface is single-source (`MergedDataView` cannot take the
 * chrome), so the sources flatten without group labels.
 */
function AddSectionPanel(props: {
  actions: ViewActions;
  onDone: () => void;
}): ReactNode {
  const { actions, onDone } = props;
  return (
    <ControlPanel.Section>
      {actions.availableSources.flatMap((source) =>
        source.types.map((v) => (
          <ControlPanel.Row
            key={`${source.sourceId ?? ""}:${v.type}`}
            icon={<Icon icon={v.icon} />}
            onSelect={() => {
              actions.addView(v.type, source.sourceId);
              onDone();
            }}
          >
            {v.title}
          </ControlPanel.Row>
        )),
      )}
    </ControlPanel.Section>
  );
}
