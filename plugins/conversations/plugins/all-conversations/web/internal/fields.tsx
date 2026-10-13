import { useMemo, type ReactElement, type ReactNode } from "react";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ConvStatusDot } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import type {
  FieldDef,
  FieldValue,
} from "@plugins/primitives/plugins/data-view/web";
import { useModelCatalog } from "@plugins/conversations/plugins/model-provider/web";
import {
  CONVERSATION_FIELDS,
  conversationModelOptions,
  type ConversationFieldSpec,
  type ConversationListRow,
} from "../../core";

// Comparable projection for one field id. Drives the toolbar sort/filter pills and
// the default table/list cell. (Under a live source search/filter/sort run
// server-side and this only powers the chrome and read cells; the Queue's
// in-memory rows evaluate it.)
function fieldValue(c: ConversationListRow, id: string): FieldValue {
  switch (id) {
    case "title":
      return c.title;
    case "status":
      return c.status;
    case "model":
      return c.model;
    case "kind":
      return c.kind;
    case "runtime":
      return c.runtime;
    case "createdAt":
      return c.createdAt;
    case "updatedAt":
      return c.updatedAt;
    case "endedAt":
      return c.endedAt;
    case "worktreePath":
      return c.worktreePath;
    case "taskTitle":
      return c.taskTitle;
    default:
      return null;
  }
}

function StatusCell({
  conv: row,
}: {
  conv: ConversationListRow;
}): ReactElement {
  // The status the conversation header shows — `working` from the instant a
  // turn is sent — so this list never disagrees with it.
  const status = useOptimisticConversationStatus(row);
  const conv = { ...row, status };
  return (
    <Inline gap="xs">
      <ConvStatusDot conv={conv} />
      <Text as="span" variant="caption">
        {status}
      </Text>
    </Inline>
  );
}

function cellFor(
  id: string,
  type: string,
): ((c: ConversationListRow) => ReactNode) | undefined {
  if (type === "date") {
    return (c: ConversationListRow) => {
      const v = fieldValue(c, id);
      return v instanceof Date ? <RelativeTime date={v} /> : null;
    };
  }
  if (id === "status")
    return (c: ConversationListRow) => <StatusCell conv={c} />;
  return undefined;
}

type FieldOptions = FieldDef<ConversationListRow>["options"];

/**
 * The web `FieldDef[]`, derived from the shared CONVERSATION_FIELDS vocabulary so
 * it can never drift from the collections' declarations. Typed over the LIST row
 * (`ConversationListRow`): the full `Conversation` the Queue holds is one, so
 * the Queue reuses them. No field names a `column` — a field id IS its column,
 * and the in-memory Queue would refuse a column ref at mount. A hook, because one
 * field's options are runtime data: the `model` filter offers the versions in
 * the LIVE model catalog, so a version discovered today is filterable without a
 * release. Until the (preloaded) catalog settles, the model field has no
 * option list — the filter takes free text rather than claiming there are no
 * models.
 */
export function useConversationFieldDefs(): FieldDef<ConversationListRow>[] {
  const catalog = useModelCatalog();
  // Memoized on the catalog read: a list memoizes its rows on the schema, so
  // a fresh one per render would re-render every row of every list over it.
  return useMemo(() => {
    const modelOptions: FieldOptions =
      catalog.status === "ready"
        ? conversationModelOptions(catalog.data)
        : undefined;
    const specs: readonly ConversationFieldSpec[] = CONVERSATION_FIELDS;
    return specs.map((spec) => ({
      id: spec.id,
      label: spec.label,
      type: spec.type,
      primary: spec.primary,
      sortable: spec.sortable,
      options: spec.id === "model" ? modelOptions : spec.options,
      value: (c: ConversationListRow) => fieldValue(c, spec.id),
      cell: cellFor(spec.id, spec.type),
    }));
  }, [catalog]);
}
