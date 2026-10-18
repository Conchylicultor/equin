import { useState } from "react";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ConversationItem } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import {
  SearchInput,
  useTextFilter,
} from "@plugins/primitives/plugins/search/web";
import { StatusIcon } from "@plugins/tasks/plugins/task-status/web";
import {
  isSettled,
  type Conversation as ConversationRecord,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const addIcon = symbol("add");

/**
 * One direction of the task's links: every linked task — open ones first,
 * resolved ones after them, struck through — each removable, then an Add that
 * opens a search over the running conversations not linked yet.
 */
export function DepSection({
  label,
  hint,
  linked,
  candidates,
  busy,
  onAdd,
  onRemove,
}: {
  label: string;
  hint: string;
  linked: TaskListItem[];
  candidates: ConversationRecord[];
  busy: string | null;
  onAdd: (conv: ConversationRecord) => void;
  onRemove: (taskId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const {
    query: search,
    setQuery: setSearch,
    filtered: availableConvs,
  } = useTextFilter({
    items: candidates,
    accessor: (c) => c.title ?? "",
  });
  const sorted = [
    ...linked.filter((t) => !isSettled(t.status)),
    ...linked.filter((t) => isSettled(t.status)),
  ];

  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="baseline">
        <SectionLabel>{label}</SectionLabel>
        <Text as="span" variant="caption" className="text-muted-foreground">
          {hint}
        </Text>
      </Stack>

      {sorted.length === 0 && !adding && (
        <Text as="div" variant="caption" className="text-muted-foreground">
          None
        </Text>
      )}
      {sorted.length > 0 && (
        <Stack as="ul" gap="none">
          {sorted.map((t) => (
            <Stack as="li" key={t.id} direction="row" gap="xs" align="center">
              <StatusIcon status={t.status} />
              <Fill as={Clip}>
                <Text
                  as="span"
                  variant="caption"
                  className={cn(
                    "truncate",
                    isSettled(t.status) && "text-muted-foreground line-through",
                  )}
                >
                  {t.title}
                </Text>
              </Fill>
              <IconButton
                icon={closeIcon}
                label="Remove link"
                disabled={busy === t.id}
                onClick={() => onRemove(t.id)}
              />
            </Stack>
          ))}
        </Stack>
      )}

      {adding ? (
        <Stack gap="xs">
          <SearchInput
            appearance="menu"
            autoFocus
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
            <Scroll as="ul" className="max-h-48 space-y-px">
              {availableConvs.map((c) => (
                <li key={c.taskId}>
                  <Row
                    size="sm"
                    onClick={() => {
                      onAdd(c);
                      setAdding(false);
                      setSearch("");
                    }}
                    disabled={busy !== null}
                  >
                    <ConversationItem conv={c} layout="inline" />
                  </Row>
                </li>
              ))}
            </Scroll>
          )}
        </Stack>
      ) : (
        <Row
          size="sm"
          onClick={() => setAdding(true)}
          icon={<Icon icon={addIcon} className="text-muted-foreground" />}
        >
          <Text as="span" variant="caption" className="text-muted-foreground">
            Add
          </Text>
        </Row>
      )}
    </Stack>
  );
}
