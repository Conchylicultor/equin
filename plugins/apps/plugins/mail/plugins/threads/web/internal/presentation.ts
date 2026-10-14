import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOption,
} from "@plugins/network/plugins/live/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  mailLabels,
  type MailLabel,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailThreads } from "../../core";

// How the threads list's fields present — registered once against its
// collection. The list body itself is `renderRow` (`ThreadRow`); these are
// what the Sort / Filter pills, Properties and any field-driven view read.

// The Gmail-issued system label ids the authored mailbox tabs are written
// against (`config/apps/mail/threads/mail-threads.jsonc`), paired with their
// human titles — so the Inbox tab's filter chip reads "Inbox", not "INBOX".
//
// A display-name lookup, not a data set: an id missing from it renders as its own
// raw id, so this list being short is a cosmetic gap, never a wrong result.
const SYSTEM_LABEL_OPTIONS: readonly LiveFieldOption[] = [
  { value: "INBOX", label: "Inbox" },
  { value: "SENT", label: "Sent" },
  { value: "DRAFT", label: "Drafts" },
  { value: "SPAM", label: "Spam" },
  { value: "TRASH", label: "Trash" },
  { value: "UNREAD", label: "Unread" },
  { value: "STARRED", label: "Starred" },
  { value: "IMPORTANT", label: "Important" },
];

// One user label as a field option: its Gmail id, shown as its name.
const labelOption = (l: MailLabel): LiveFieldOption => ({
  value: l.id,
  label: l.name,
});

/**
 * The `labels` field's options: each Gmail label id → its friendly name, which
 * every mailbox tab's filter chip renders — so "Label_12" never reaches the
 * screen. The system ids are always known; the user labels come from
 * `mail-core`'s `mailLabels` live value.
 *
 * Always an answer (never a pending read), on purpose: the options are a
 * display-name LOOKUP, not the value set — a label id missing from it renders
 * as its raw id, which is what an unsynced id already does — and every
 * mailbox tab filters by `labels`, so a pending field would hold every tab on
 * its loading state for a cosmetic lookup. The loading arm is the system
 * labels alone; a failed read keeps the last user labels it saw (live-state
 * reports the failure itself).
 */
export function useMailLabelOptions(): readonly LiveFieldOption[] {
  const userLabels = useLive(mailLabels);
  return useMemo(
    () =>
      foldResource(userLabels, {
        loading: () => SYSTEM_LABEL_OPTIONS,
        error: (_error, stale) =>
          stale === undefined
            ? SYSTEM_LABEL_OPTIONS
            : [...SYSTEM_LABEL_OPTIONS, ...stale.map(labelOption)],
        ready: (labels) => [
          ...SYSTEM_LABEL_OPTIONS,
          ...labels.map(labelOption),
        ],
      }),
    [userLabels],
  );
}

export const mailThreadsPresentation = FieldPresentation.Register({
  owner: mailThreads,
  fields: {
    lastMessageAt: { align: "end" },
    labels: { useOptions: useMailLabelOptions },
    // Searched (the source's `searchable`), never a column of its own.
    snippet: { visible: false },
    // The pane's scope: never a column, never offered to Filter.
    accountId: { visible: false },
  },
});
