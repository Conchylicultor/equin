import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { DataViewSection } from "@plugins/primitives/plugins/data-view/web";
import type { ConversationSectionId } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { isUserSection } from "./queue-sections";
import type { QueueSectionControls } from "./queue-section-controls";

const addIcon = symbol("add");
const moreIcon = symbol("more-horiz");
const editIcon = symbol("edit");
const upIcon = symbol("arrow-upward");
const downIcon = symbol("arrow-downward");
const deleteIcon = symbol("delete");

/**
 * The Queue's section-header affordances (`DataViewProps.headerActions`): a
 * user section gets "+" (a new section right below it) and a ⋯ menu (Rename,
 * Move up / down, Delete); the Queue gets "+" (a new section last, which is
 * right above the Queue). Every other section has none.
 */
export function queueHeaderActions(
  controls: QueueSectionControls,
): (section: DataViewSection<unknown>) => ReactNode {
  return (section) => {
    const { key } = section;
    if (isUserSection(key))
      return (
        <UserSectionActions
          id={key}
          name={typeof section.label === "string" ? section.label : "Section"}
          count={section.count.n}
          controls={controls}
        />
      );
    if (key === "queued")
      return (
        <IconButton
          icon={addIcon}
          label="New section"
          onClick={() => controls.create({})}
        />
      );
    return null;
  };
}

function UserSectionActions({
  id,
  name,
  count,
  controls,
}: {
  id: ConversationSectionId;
  name: string;
  count: number;
  controls: QueueSectionControls;
}): ReactElement {
  const { sections } = controls;
  const at = sections.findIndex((s) => s.id === id);
  const above = at > 0 ? sections[at - 1] : undefined;
  const below = at >= 0 ? sections[at + 1] : undefined;
  return (
    <>
      <IconButton
        icon={addIcon}
        label="Add section below"
        onClick={() => controls.create({ after: id })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton icon={moreIcon} label={`${name} options`} />}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => controls.setRenaming(id)}>
            <Icon icon={editIcon} className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!above}
            onClick={() =>
              above && controls.move(id, { targetId: above.id, zone: "before" })
            }
          >
            <Icon icon={upIcon} className="size-4" />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!below}
            onClick={() =>
              below && controls.move(id, { targetId: below.id, zone: "after" })
            }
          >
            <Icon icon={downIcon} className="size-4" />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => controls.remove(id)}
          >
            <Icon icon={deleteIcon} className="size-4" />
            {count > 0 ? `Delete · ${count} back to Queue` : "Delete section"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
