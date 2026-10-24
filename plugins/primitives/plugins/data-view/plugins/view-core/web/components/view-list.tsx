import { type ReactNode, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  SortableItem,
  SortableList,
} from "@plugins/primitives/plugins/sortable-list/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "../internal/resolve-instances";
import type { ViewActionsCore } from "../internal/use-view-model";

const addIcon = symbol("add");
const moreIcon = symbol("more-horiz");
const editIcon = symbol("edit");
const contentCopyIcon = symbol("content-copy");
const deleteIcon = symbol("delete");

export interface ViewListProps<T extends ViewTypeMeta> {
  instances: ResolvedViewInstance<T>[];
  activeId: string;
  onSelect: (id: string) => void;
  actions: ViewActionsCore;
  /** The surface's home view: listed first, never dragged, renamed or
   *  deleted, and nothing can be dropped above it. */
  homeId?: string | null;
  /** A view's row count, drawn after its name (`undefined` = not known: no
   *  number rather than a wrong one). */
  countFor?: (id: string) => number | undefined;
  /** Whether a view has unsaved edits — a dot after its name. */
  dirtyFor?: (id: string) => boolean;
  /**
   * Each row's ⋯ menu (Rename / Duplicate / Delete) and inline rename.
   * Default `true`; `false` lists the views to pick and drag only (a picker
   * hung off a collapsed chip).
   */
  editable?: boolean;
  /**
   * Which view's name is being edited inline — CONTROLLED when given (the host
   * can then start a rename itself, e.g. on a view it just created), else the
   * list's own state.
   */
  renaming?: { id: string | null; set: (id: string | null) => void };
  /** A trailing "+ {label}" row. */
  create?: { label: string; onCreate: () => void };
}

/**
 * The views as a vertical list: icon, name, count, a dirty dot, and (editable)
 * a hover ⋯ menu of Rename / Duplicate / Delete, drag to reorder, and an
 * optional trailing create row. The vertical twin of `EditableViewSwitcher`,
 * for a surface that lists its views in a side panel (a sidebar of saved
 * filters) or in a chip's popover.
 *
 * Reorder is the sortable-list primitive's; the home view (`homeId`) is not a
 * drag source and a drop above it lands just below it, so it stays first.
 */
export function ViewList<T extends ViewTypeMeta>({
  instances,
  activeId,
  onSelect,
  actions,
  homeId = null,
  countFor,
  dirtyFor,
  editable = true,
  renaming: controlledRenaming,
  create,
}: ViewListProps<T>): ReactNode {
  const [ownRenamingId, setOwnRenamingId] = useState<string | null>(null);
  const renaming = controlledRenaming ?? {
    id: ownRenamingId,
    set: setOwnRenamingId,
  };
  const ids = instances.map((r) => r.instance.id);
  const homeIndex = homeId === null ? -1 : ids.indexOf(homeId);

  const onMove = (movedId: string, overId: string) => {
    const overIndex = ids.indexOf(overId);
    if (overIndex < 0 || movedId === homeId) return;
    actions.reorderView(movedId, Math.max(overIndex, homeIndex + 1));
  };

  return (
    <Stack gap="none">
      <SortableList items={ids} onMove={onMove} orientation="vertical">
        <Stack gap="none">
          {instances.map((r) => {
            const id = r.instance.id;
            const isHome = id === homeId;
            const isRenaming = editable && renaming.id === id && !isHome;
            return (
              <SortableItem key={id} id={id} disabled={isHome || isRenaming}>
                {() => (
                  <ViewListRow
                    instance={r}
                    active={id === activeId}
                    count={countFor?.(id)}
                    dirty={dirtyFor?.(id) ?? false}
                    renaming={isRenaming}
                    menu={editable && !isHome}
                    onSelect={() => onSelect(id)}
                    onRename={(name) => {
                      renaming.set(null);
                      if (name !== null && name !== r.instance.name) {
                        actions.renameView(id, name);
                      }
                    }}
                    onStartRename={() => renaming.set(id)}
                    onDuplicate={() => actions.duplicateView(id)}
                    onDelete={() => actions.deleteView(id)}
                  />
                )}
              </SortableItem>
            );
          })}
        </Stack>
      </SortableList>
      {create ? (
        <Row
          icon={<Icon icon={addIcon} className="text-muted-foreground" />}
          onClick={create.onCreate}
        >
          <Text variant="label" className="text-muted-foreground">
            {create.label}
          </Text>
        </Row>
      ) : null}
    </Stack>
  );
}

/** One view's line. While renaming it is a plain container holding the name
 *  field (a field inside a button is invalid DOM), else a button that selects
 *  the view. */
function ViewListRow<T extends ViewTypeMeta>(props: {
  instance: ResolvedViewInstance<T>;
  active: boolean;
  count: number | undefined;
  dirty: boolean;
  renaming: boolean;
  menu: boolean;
  onSelect: () => void;
  /** Commit (`name`) or cancel (`null`) the inline rename. */
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): ReactNode {
  const { instance, active, count, dirty, renaming, menu } = props;
  const name = instance.instance.name;
  return (
    <Row
      size="sm"
      selected={active}
      data-view-id={instance.instance.id}
      icon={<Icon icon={instance.instance.icon} />}
      onClick={renaming ? undefined : props.onSelect}
      actions={
        menu && !renaming ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<IconButton icon={moreIcon} label={`${name} actions`} />}
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={props.onStartRename}>
                <Icon icon={editIcon} className="size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onDuplicate}>
                <Icon icon={contentCopyIcon} className="size-4" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={props.onDelete}>
                <Icon icon={deleteIcon} className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    >
      {renaming ? (
        <Fill>
          <RenameField name={name} onDone={props.onRename} />
        </Fill>
      ) : (
        <Fill>
          <Text variant="label">{name}</Text>
        </Fill>
      )}
      {dirty ? (
        <span title="Unsaved changes" aria-label="Unsaved changes">
          <StatusDot colorClass="bg-primary" />
        </span>
      ) : null}
      {count !== undefined ? (
        <Text variant="caption" className="text-muted-foreground tabular-nums">
          {count}
        </Text>
      ) : null}
    </Row>
  );
}

/** The inline name field: Enter or blur commits, Escape cancels (and the blur
 *  that follows it commits nothing). An empty name cancels. */
function RenameField(props: {
  name: string;
  onDone: (name: string | null) => void;
}): ReactNode {
  const settled = useRef(false);
  const done = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    props.onDone(name);
  };
  return (
    <Input
      autoFocus
      defaultValue={props.name}
      aria-label="View name"
      onBlur={(e) => {
        const next = e.target.value.trim();
        done(next.length > 0 ? next : null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const next = e.currentTarget.value.trim();
          done(next.length > 0 ? next : null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done(null);
        }
      }}
    />
  );
}
