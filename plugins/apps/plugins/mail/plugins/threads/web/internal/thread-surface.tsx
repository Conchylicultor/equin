import type {
  FieldDef,
  RowTone,
} from "@plugins/primitives/plugins/data-view/web";
import type { MailThreadRow } from "../../core";
import { senderSummary } from "./sender-summary";

/**
 * What every surface listing threads says of them (the mailbox tabs, a search's
 * hits): the inbox recipe, the star leading the row, and unread rows in a
 * strong weight. The rest — subject, snippet, date, the important / attachment
 * marks — is the thread's own fields, presented in `./presentation.tsx`.
 */
export const THREAD_PLACE = { starred: "lead" } as const;

export function threadRowTone(t: MailThreadRow): RowTone {
  return t.unread ? "strong" : "default";
}

/**
 * The fields a thread computes: who the conversation is with (a person, so the
 * inbox recipe makes it the row's title) and its preview. `data-thread-id` names the thread
 * the row shows, which the e2e scripts read.
 */
export const THREAD_EXTRA_FIELDS: FieldDef<MailThreadRow>[] = [
  {
    id: "senders",
    label: "From",
    type: "person",
    value: (t) => senderSummary(t),
    cell: (t) => <span data-thread-id={t.id}>{senderSummary(t)}</span>,
  },
  // The snippet as prose (line 2 of the row); the stored `snippet` stays the
  // searched, filterable field and is hidden (`./presentation.tsx`).
  {
    id: "preview",
    label: "Preview",
    type: "multiline-text",
    value: (t) => t.snippet,
  },
];
