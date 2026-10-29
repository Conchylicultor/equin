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
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { mailThreads } from "../../core";

// How the threads list's fields present — registered once against its
// collection. The rows are the inbox recipe over these fields (`./thread-surface`).

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

const starIcon = symbol("star");
const attachFileIcon = symbol("attach-file");
const labelImportantIcon = symbol("label-important");

export const mailThreadsPresentation = FieldPresentation.Register({
  owner: mailThreads,
  fields: {
    subject: { cell: (subject) => subject || "(no subject)" },
    // The star leads the row (`THREAD_PLACE`); the marks are flags, so they
    // follow the subject. An unset mark draws nothing.
    starred: {
      cell: (starred) => (
        <Icon
          icon={starIcon}
          active={starred}
          className={
            starred
              ? "icon-auto text-warning"
              : "icon-auto text-muted-foreground"
          }
        />
      ),
    },
    important: {
      cell: (important) =>
        important ? (
          <Icon icon={labelImportantIcon} className="icon-auto text-warning" />
        ) : null,
    },
    hasAttachments: {
      cell: (has) =>
        has ? (
          <Icon
            icon={attachFileIcon}
            className="icon-auto text-muted-foreground"
          />
        ) : null,
    },
    // Unread is the row's weight (`threadRowTone`), not a mark of its own.
    unread: { visible: false },
    // Searched (the source's `searchable`); the row draws it as `preview`.
    snippet: { visible: false },
    messageCount: { visible: false },
    labels: { useOptions: useMailLabelOptions, visible: false },
    // The pane's scope: never a column, never offered to Filter.
    accountId: { visible: false },
  },
});
