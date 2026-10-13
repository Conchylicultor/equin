import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ConversationItem } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import {
  SearchInput,
  useTextFilter,
} from "@plugins/primitives/plugins/search/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");

export function DepPopoverContent({
  label,
  currentConvs,
  orphanIds,
  allTasks,
  candidates,
  busy,
  onAdd,
  onRemove,
}: {
  label: string;
  currentConvs: ConversationRecord[];
  orphanIds: string[];
  allTasks: TaskListItem[];
  candidates: ConversationRecord[];
  busy: string | null;
  onAdd: (conv: ConversationRecord) => void;
  onRemove: (taskId: string) => void;
}) {
  const {
    query: search,
    setQuery: setSearch,
    filtered: availableConvs,
  } = useTextFilter({
    items: candidates,
    accessor: (c) => c.title ?? "",
  });

  return (
    <>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset on the section label; siblings sit in a fragment with no flex parent to own the gap */}
      <SectionLabel className="mb-1.5">{label}</SectionLabel>

      {(currentConvs.length > 0 || orphanIds.length > 0) && (
        // eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset separating the current-deps list from the search input; fragment parent can't own the gap
        <ul className="mb-2 space-y-px">
          {currentConvs.map((c) => (
            <Stack
              as="li"
              key={c.taskId}
              direction="row"
              gap="xs"
              align="center"
            >
              <Fill as={Clip}>
                <ConversationItem conv={c} layout="inline" />
              </Fill>
              <button
                type="button"
                onClick={() => onRemove(c.taskId!)}
                disabled={busy === c.taskId}
                className={cn(
                  "hover:bg-destructive/10 hover:text-destructive rounded-md p-2xs",
                  rigidClass(),
                )}
                aria-label="Remove"
              >
                <Icon icon={closeIcon} className="size-3" />
              </button>
            </Stack>
          ))}
          {orphanIds.map((id) => {
            const depTask = allTasks.find((t) => t.id === id);
            const isTerminal =
              depTask?.status === "done" || depTask?.status === "dropped";
            return (
              <Stack as="li" key={id} direction="row" gap="xs" align="center">
                <Text
                  as="span"
                  className={cn(
                    fillClasses("x"),
                    "text-caption truncate",
                    isTerminal && "text-muted-foreground line-through",
                  )}
                >
                  {depTask?.title ?? id}
                </Text>
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  disabled={busy === id}
                  className={cn(
                    "hover:bg-destructive/10 hover:text-destructive rounded-md p-2xs",
                    rigidClass(),
                  )}
                  aria-label="Remove"
                >
                  <Icon icon={closeIcon} className="size-3" />
                </button>
              </Stack>
            );
          })}
        </ul>
      )}

      <SearchInput
        appearance="menu"
        placeholder="Search conversations…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset separating the search input from the list below it; siblings sit in a fragment with no flex parent to own the gap, and `wrapperClassName` is SearchInput's only handle on its outermost box (the same offset its two siblings above carry)
        wrapperClassName={cn("mb-1.5")}
      />
      {availableConvs.length === 0 ? (
        <Text
          as="div"
          variant="caption"
          className="py-sm text-center text-muted-foreground"
        >
          No conversations found
        </Text>
      ) : (
        <Scroll as="ul" className="max-h-64 space-y-px">
          {availableConvs.map((c) => (
            <li key={c.taskId}>
              <Row size="sm" onClick={() => onAdd(c)} disabled={busy !== null}>
                <ConversationItem conv={c} layout="inline" />
              </Row>
            </li>
          ))}
        </Scroll>
      )}
    </>
  );
}
