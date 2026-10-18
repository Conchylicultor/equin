import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  DropdownMenuItem,
  DropdownMenuSection,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { CursorAnchoredMenu } from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { shelfConfig } from "@plugins/apps/plugins/desktop/plugins/shell/core";
import {
  LAUNCHER_COLUMNS,
  clampSelection,
  listLauncher,
  type LauncherListing,
  moveSelection,
  type SelectionKey,
} from "../internal/launcher-model";
import {
  useAppActions,
  useLauncherApps,
  type LauncherApp,
} from "../internal/use-launcher-apps";
import {
  useLauncherCommands,
  type LauncherCommand,
} from "../internal/use-launcher-commands";
import {
  AppGridCell,
  AppRow,
  CommandRow,
  GroupHeader,
  type CellWiring,
} from "./launcher-rows";

const searchIcon = symbol("search");
const openIcon = symbol("web-asset");
const addIcon = symbol("add");
const pinIcon = symbol("keep");

const ARROWS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** An app's context menu, open at a viewport point. */
interface AppMenu {
  x: number;
  y: number;
  appId: string;
}

/**
 * The launcher dialog (mockup `#launcher`): a search field over either the grid
 * of every app (empty query) or the matching apps then commands (a query), with
 * a footer of key hints. The field keeps focus throughout — arrow keys move the
 * selection, Enter runs it (Shift+Enter opens a new window), Esc or a click on
 * the backdrop closes — and hovering an item moves the selection onto it.
 */
export function LauncherPanel({ onClose }: { onClose(): void }) {
  const apps = useLauncherApps();
  const commands = useLauncherCommands();
  const { activate, newWindow } = useAppActions();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const [menu, setMenu] = useState<AppMenu | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const listing = useMemo(
    () => listLauncher(query, apps, commands),
    [query, apps, commands],
  );
  const count = listing.items.length;
  const selected = clampSelection(selection, count);

  function run(index: number, fresh: boolean) {
    const item = listing.items[index];
    if (!item) return;
    onClose();
    if (item.kind === "app") (fresh ? newWindow : activate)(item.app.id);
    else item.command.run();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (ARROWS.has(e.key)) {
      e.preventDefault();
      setSelection(
        moveSelection(selected, e.key as SelectionKey, listing.layout, count),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected, e.shiftKey);
    }
  }

  const cell = (index: number) => ({
    index,
    selected: index === selected,
    onHover: setSelection,
    onRun: run,
  });
  const menuFor = (appId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, appId });
  };

  return (
    <>
      <Layer
        layer="overlay"
        // A press anywhere outside the panel closes it; the panel stops its own.
        onPointerDown={onClose}
        className="bg-black/20 animate-in fade-in-0 duration-100"
      >
        <Stack
          gap="none"
          align="center"
          className="px-lg pb-lg"
          // The mockup drops the panel 12vh from the top; a viewport share, not a ramp step.
          style={{ paddingTop: "12vh" }}
        >
          <Surface
            level="overlay"
            onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
            role="dialog"
            aria-label="Apps"
            className={cn(
              "w-full max-w-160 rounded-2xl bg-popover/90 backdrop-blur-2xl backdrop-saturate-180",
              // The mockup's two-layer lift; no shadow token carries this much spread.
              "shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45),0_4px_12px_rgba(0,0,0,0.1)]",
              "animate-in fade-in-0 zoom-in-97 slide-in-from-top-1.5 duration-150 ease-out",
            )}
          >
            <Clip className="rounded-2xl">
              <Stack gap="none">
                <Stack
                  direction="row"
                  gap="md"
                  align="center"
                  className="h-14 border-b border-border px-lg text-muted-foreground"
                >
                  <Icon
                    icon={searchIcon}
                    className={cn(rigidClass(), "size-4.5")}
                  />
                  <input
                    ref={input}
                    autoFocus
                    value={query}
                    placeholder="Search apps and commands…"
                    autoComplete="off"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelection(0);
                    }}
                    onKeyDown={onKeyDown}
                    className={cn(
                      fillClasses("x"),
                      "bg-transparent text-subheading font-normal text-foreground outline-none placeholder:text-faint-foreground",
                    )}
                  />
                  <Kbd>esc</Kbd>
                </Stack>
                <Scroll className="max-h-[min(440px,56vh)] px-sm pt-xs pb-md">
                  {listing.layout === "grid" ? (
                    <>
                      <GroupHeader>All apps</GroupHeader>
                      <Grid cols={LAUNCHER_COLUMNS} gap="2xs">
                        {apps.map((app, i) => (
                          <AppGridCell
                            key={app.id}
                            app={app}
                            onContextMenu={menuFor(app.id)}
                            {...cell(i)}
                          />
                        ))}
                      </Grid>
                    </>
                  ) : (
                    <SearchListing
                      listing={listing}
                      query={query}
                      cell={cell}
                      menuFor={menuFor}
                    />
                  )}
                </Scroll>
                <Cluster
                  gap="lg"
                  className="border-t border-border px-lg py-sm text-muted-foreground"
                >
                  <Text variant="caption" tone="muted">
                    <Kbd>↵</Kbd> open
                  </Text>
                  <Text variant="caption" tone="muted">
                    <Kbd>⇧</Kbd> <Kbd>↵</Kbd> new window
                  </Text>
                  <Text variant="caption" tone="muted">
                    Right-click an app to keep it in the dock
                  </Text>
                </Cluster>
              </Stack>
            </Clip>
          </Surface>
        </Stack>
      </Layer>
      <AppContextMenu
        menu={menu}
        apps={apps}
        onClose={() => {
          setMenu(null);
          // The menu took focus; hand it back so the keyboard keeps working.
          input.current?.focus();
        }}
        onDismissLauncher={onClose}
        activate={activate}
        newWindow={newWindow}
      />
    </>
  );
}

/** The search layout: matching apps, then matching commands, or "No results". */
function SearchListing({
  listing,
  query,
  cell,
  menuFor,
}: {
  listing: LauncherListing<LauncherApp, LauncherCommand>;
  query: string;
  cell: (index: number) => CellWiring;
  menuFor: (appId: string) => (e: React.MouseEvent) => void;
}) {
  if (listing.items.length === 0) {
    return <GroupHeader>No results for “{query}”</GroupHeader>;
  }
  return (
    <>
      {listing.apps.length > 0 && (
        <>
          <GroupHeader>Apps</GroupHeader>
          {listing.apps.map((app, i) => (
            <AppRow
              key={app.id}
              app={app}
              onContextMenu={menuFor(app.id)}
              {...cell(i)}
            />
          ))}
        </>
      )}
      {listing.commands.length > 0 && (
        <>
          <GroupHeader>Commands</GroupHeader>
          {listing.commands.map((command, i) => (
            <CommandRow
              key={command.id}
              command={command}
              {...cell(listing.apps.length + i)}
            />
          ))}
        </>
      )}
    </>
  );
}

/**
 * Right-click on an app: its name, Open, New window, and whether it stays in
 * the dock. The dock's pinned list is the shelf's global config, so the pin row
 * waits for it to load (it would otherwise name an action from a guess).
 */
function AppContextMenu({
  menu,
  apps,
  onClose,
  onDismissLauncher,
  activate,
  newWindow,
}: {
  menu: AppMenu | null;
  apps: LauncherApp[];
  onClose(): void;
  onDismissLauncher(): void;
  activate(appId: string): void;
  newWindow(appId: string): void;
}) {
  const shelf = useConfigResult(shelfConfig);
  const setShelf = useSetConfig(shelfConfig);
  const app = menu ? apps.find((a) => a.id === menu.appId) : undefined;
  // Not known yet (or failed): the pin row is shown but disabled, claiming nothing.
  const pinned = foldResource(shelf, {
    loading: () => null,
    error: () => null,
    ready: (values) => values.pinnedApps,
  });
  const isPinned = app !== undefined && pinned?.includes(app.id) === true;
  return (
    <CursorAnchoredMenu
      anchor={menu && app ? { x: menu.x, y: menu.y } : null}
      onClose={onClose}
    >
      {app && (
        <DropdownMenuSection label={app.name}>
          <DropdownMenuItem
            onClick={() => {
              onDismissLauncher();
              activate(app.id);
            }}
          >
            <Icon icon={openIcon} />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              onDismissLauncher();
              newWindow(app.id);
            }}
          >
            <Icon icon={addIcon} />
            New window
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pinned === null}
            onClick={() => {
              if (pinned === null) return;
              setShelf(
                "pinnedApps",
                isPinned
                  ? pinned.filter((id) => id !== app.id)
                  : [...pinned, app.id],
              );
            }}
          >
            <Icon icon={pinIcon} />
            {isPinned ? "Remove from dock" : "Keep in dock"}
          </DropdownMenuItem>
        </DropdownMenuSection>
      )}
    </CursorAnchoredMenu>
  );
}
