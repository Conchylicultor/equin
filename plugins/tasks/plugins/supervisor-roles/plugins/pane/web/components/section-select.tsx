import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  conversationSectionIdKind,
  queueSections,
  type ConversationSectionId,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";

// The Select's value for the Queue (no section): never a section id, whose
// spelling is always `csec-…`.
const QUEUE = "queue";

/**
 * The sidebar section a role's new sessions land in: the Queue, or one of the
 * user's own sections (live, rank order).
 */
export function SectionSelect({
  value,
  onChange,
}: {
  value: ConversationSectionId | null;
  onChange: (section: ConversationSectionId | null) => void;
}): ReactElement {
  const sections = useLive(queueSections);
  return foldResource(sections, {
    loading: () => <Loading variant="block" className="h-8 w-full" />,
    error: (err) => <Placeholder tone="error">{err.message}</Placeholder>,
    ready: (rows) => {
      const items: Record<string, string> = { [QUEUE]: "Queue" };
      for (const s of rows) items[s.id] = s.name;
      return (
        <Select
          items={items}
          value={value ?? QUEUE}
          onValueChange={(v: string | null) => {
            if (v === null) return;
            onChange(v === QUEUE ? null : conversationSectionIdKind.key(v));
          }}
        >
          <SelectTrigger aria-label="Section" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={QUEUE}>Queue</SelectItem>
            {rows.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    },
  });
}
