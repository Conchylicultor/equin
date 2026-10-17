import type { ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const icons = {
  filter: symbol("filter-list"),
  sort: symbol("swap-vert"),
  tune: symbol("tune"),
  settings: symbol("settings"),
  chevronDown: symbol("keyboard-arrow-down"),
  list: symbol("list"),
  table: symbol("table"),
  board: symbol("view-column"),
  gallery: symbol("grid-view"),
  add: symbol("add"),
  none: symbol("block"),
  code: symbol("code"),
  push: symbol("arrow-circle-up"),
  bolt: symbol("bolt"),
  eye: symbol("visibility"),
  infinity: symbol("all-inclusive"),
  timer: symbol("timer"),
  more: symbol("more-horiz"),
  edit: symbol("edit"),
  link: symbol("link"),
  copy: symbol("content-copy"),
  archive: symbol("archive"),
  trash: symbol("delete"),
  hand: symbol("back-hand"),
};

/**
 * Every kind of dropdown menu the app draws, held open side by side — the
 * `ui-kit/menu-sheet` exhibit. The same five menus, with the same content, as
 * the Menu prototype (`proto-1791412353-x9vk`), so the two can be compared
 * frame against frame: the data-view toolbar's options panel (a control
 * panel with its search field inside), a picker, a view switcher (with a submenu), row actions (shortcuts, a disabled
 * row, a destructive one) and a described pick list.
 *
 * Every menu is controlled open and non-modal, so all of them stay up at once
 * and none locks the page. An exhibit, not a working copy: picking an item
 * does nothing.
 */
export default function MenuSheetExhibit() {
  return (
    <Inset pad="xl">
      <Grid minCellWidth="20rem" mode="fit" gap="md">
        <Specimen
          title="View options"
          note="the search field inside the panel, then one row per control"
        >
          {/* The data-view toolbar's options fold, as it is built: a control
              panel (not a DropdownMenu) whose first section is the search
              field, at the same `menu` width role. */}
          <ControlPanelPopover
            open
            align="start"
            label="View options"
            trigger={
              <IconButton
                icon={icons.tune}
                label="View options"
                variant="ghost"
              />
            }
          >
            <ControlPanel.Section>
              <SearchInput
                value=""
                onChange={() => {}}
                placeholder="Search…"
                appearance="menu"
              />
            </ControlPanel.Section>
            <ControlPanel.Section>
              <ControlPanel.Row
                icon={<Icon icon={icons.filter} />}
                push={{
                  key: "filter",
                  title: "Filter",
                  render: () => null,
                }}
              >
                Filter
              </ControlPanel.Row>
              <ControlPanel.Row
                icon={<Icon icon={icons.sort} />}
                trailing="Last updated"
                push={{
                  key: "sort",
                  title: "Sort",
                  render: () => null,
                }}
              >
                Sort
              </ControlPanel.Row>
              <ControlPanel.Row
                icon={<Icon icon={icons.tune} />}
                push={{
                  key: "settings",
                  title: "View settings",
                  render: () => null,
                }}
              >
                View settings
              </ControlPanel.Row>
            </ControlPanel.Section>
          </ControlPanelPopover>
        </Specimen>

        <Specimen title="Picker" note="one labelled group, the choice checked">
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger render={<Button variant="secondary" />}>
              Preprompt <Text tone="muted">None</Text>
              <Icon icon={icons.chevronDown} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuSection label="Preprompt">
                <DropdownMenuRadioGroup value="none">
                  <DropdownMenuRadioItem value="none">
                    <Icon icon={icons.none} /> None
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="implement">
                    <Icon icon={icons.code} /> Auto-implement
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="push">
                    <Icon icon={icons.push} /> Auto-push
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="no-human">
                    <Icon icon={icons.bolt} /> Auto-push{" "}
                    <Text tone="faint">no human</Text>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="check">
                    <Icon icon={icons.eye} /> Auto-push{" "}
                    <Text tone="faint">check</Text>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="autonomous">
                    <Icon icon={icons.infinity} /> Autonomous
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="perf">
                    <Icon icon={icons.timer} /> Perf
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSection>
            </DropdownMenuContent>
          </DropdownMenu>
        </Specimen>

        <Specimen title="Views" note="the current view checked, a submenu open">
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger render={<Button variant="secondary" />}>
              <Icon icon={icons.list} />
              Queue
              <Icon icon={icons.chevronDown} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuSection label="Views">
                <DropdownMenuRadioGroup value="queue">
                  <DropdownMenuRadioItem value="queue">
                    <Icon icon={icons.list} /> Queue
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="models">
                    <Icon icon={icons.table} /> Models
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="history">
                    <Icon icon={icons.board} /> History
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSection>
              <DropdownMenuSeparator />
              <DropdownMenuSub open>
                <DropdownMenuSubTrigger>
                  <Icon icon={icons.add} />
                  Add view
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem>
                    <Icon icon={icons.list} /> List
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Icon icon={icons.table} /> Table
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Icon icon={icons.board} /> Board
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Icon icon={icons.gallery} /> Gallery
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem>
                <Icon icon={icons.settings} />
                View settings…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Specimen>

        <Specimen
          title="Row actions"
          note="shortcuts, a disabled row, a destructive one"
        >
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger
              render={
                <Button variant="secondary" aspect="icon" aria-label="More" />
              }
            >
              <Icon icon={icons.more} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>
                <Icon icon={icons.edit} /> Rename
                <DropdownMenuShortcut>R</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon icon={navIcons.newTab} /> Open in new tab
                <DropdownMenuShortcut>⌘↵</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon icon={icons.link} /> Copy link
                <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Icon icon={icons.copy} /> Duplicate
                <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Icon icon={icons.archive} /> Archive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Icon icon={icons.trash} /> Delete
                <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Specimen>

        <Specimen
          title="Described"
          note="when a label alone does not say enough"
        >
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger render={<Button variant="secondary" />}>
              Push <Text tone="muted">Ask first</Text>
              <Icon icon={icons.chevronDown} />
            </DropdownMenuTrigger>
            <DropdownMenuContent width="described">
              <DropdownMenuRadioGroup value="ask">
                <DropdownMenuRadioItem value="ask">
                  <Described
                    icon={<Icon icon={icons.hand} />}
                    label="Ask first"
                    hint="The agent stops and waits for your review."
                  />
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="checks">
                  <Described
                    icon={<Icon icon={icons.push} />}
                    label="Push when checks pass"
                    hint="Lands on main after a green build."
                  />
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="never">
                  <Described
                    icon={<Icon icon={icons.none} />}
                    label="Never push"
                    hint="Keep the work on its branch."
                  />
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </Specimen>
      </Grid>
    </Inset>
  );
}

/** One captioned card holding a trigger; its open menu floats over the room below. */
function Specimen({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-h-96">
      <Stack gap="sm" align="start">
        <Stack direction="row" gap="xs" wrap>
          <Text variant="caption" tone="strong">
            {title}
          </Text>
          <Text variant="caption" tone="faint">
            {note}
          </Text>
        </Stack>
        {children}
      </Stack>
    </Card>
  );
}

/** A two-line pick: label over a sentence saying what it does. */
function Described({
  icon,
  label,
  hint,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Stack direction="row" gap="xs" align="start">
      {icon}
      <Stack gap="none">
        <Text>{label}</Text>
        <Text variant="caption" tone="faint">
          {hint}
        </Text>
      </Stack>
    </Stack>
  );
}
