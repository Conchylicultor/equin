import { useMemo, type ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { GmailAccessEmptyState } from "@plugins/integrations/plugins/gmail/web";
import { threadPane } from "@plugins/apps/plugins/mail/plugins/reading-pane/web";
import { mailApp } from "@plugins/apps/plugins/mail/plugins/shell/core";
import {
  mailAccount,
  mailAccountIdKind,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import type { MailThreadRow } from "../core";
import { mailThreadsSource } from "./internal/source";
import { ThreadRow } from "./components/thread-row";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const starIcon = symbol("star");

const MAIL_THREADS_VIEW = defineDataView("mail-threads");

/**
 * The one mail surface: ONE url, ONE DataView, the mailboxes as its TABS.
 *
 * Every mailbox is an authored view instance in
 * `config/apps/mail/threads/mail-threads.jsonc`, and its scope is that view's
 * ordinary `filter` — so switching mailbox is switching tab, and the scope is an
 * editable chip in the Filter pill that the user owns. There is no route param
 * and no server-derived scope: the active view's tree travels the standard
 * filter → live window path like every other rule (the scope of each window
 * tuple is the connected account's id, stated as data), and an edit persists
 * straight back into the config row.
 */
export const mailThreadsPane = Pane.define({
  title: "Mail",
  route: defineRoute({ id: "mail-threads", segment: "threads" }),
  app: mailApp,
  component: MailThreadsPaneView,
  width: 520,
});

function MailThreadsPaneView(): ReactElement {
  // The list is the connected account's threads: its id scopes the live source.
  // Not known yet is the list's own loading state (its toolbar already up),
  // never an empty list; a failed read is its error; no account yet is the
  // not-connected state.
  const account = useLive(mailAccount);
  return (
    <PaneChrome pane={mailThreadsPane}>
      {matchResource(account, {
        loading: () => <MailThreadsList accountId={null} />,
        ready: (data) =>
          data === null ? (
            // No account row yet: Gmail is not usable (the integration names
            // what is missing and renders its fix), or it is and the first
            // sync has not created the account.
            <GmailAccessEmptyState whenReady="Gmail is connected — your mailbox appears here once its first sync has run." />
          ) : (
            <MailThreadsList accountId={data.id} />
          ),
      })}
    </PaneChrome>
  );
}

function MailThreadsList({
  accountId,
}: {
  /** `null`: the account is still loading — the source awaits its scope. */
  accountId: string | null;
}): ReactElement {
  const openPane = useOpenPane();
  // The account is the scope every tuple carries — data, not a server-side
  // subquery. The DataView never offers a scope column to the Filter control,
  // so the user can neither name nor widen it.
  const source = useMemo(
    () =>
      accountId === null
        ? mailThreadsSource.awaitingScope(["accountId"])
        : mailThreadsSource.scoped({
            where: { accountId: mailAccountIdKind.key(accountId) },
          }),
    [accountId],
  );

  // The open thread, straight off the reading pane's own route param — so the
  // list highlights the row the user is reading without holding selection state.
  const selectedRowId = threadPane.useRouteEntry()?.params.threadId;

  return (
    <DataView<MailThreadRow>
      storageKey={MAIL_THREADS_VIEW}
      views={["list"]}
      selectedRowId={selectedRowId}
      // Said once the window settled on no thread — never while it loads.
      emptyState="No conversations"
      viewOptions={{
        list: {
          size: "md",
          leading: (t: MailThreadRow) =>
            t.starred ? (
              <Icon icon={starIcon} active className="icon-auto text-warning" />
            ) : (
              <Icon
                icon={starIcon}
                className="icon-auto text-muted-foreground"
              />
            ),
          renderRow: (t: MailThreadRow) => <ThreadRow thread={t} />,
        },
      }}
      source={source}
      rowActivation={(t) =>
        openPane.to(threadPane, { threadId: t.id }, { mode: "push" })
      }
    />
  );
}
