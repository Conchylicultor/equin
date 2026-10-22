import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { PaneChrome, useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
} from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  type ResourceReadiness,
} from "@plugins/primitives/plugins/live-state/web";
import {
  GmailAccessAction,
  GmailAccessEmptyState,
  useGmailAccess,
} from "@plugins/integrations/plugins/gmail/web";
import { mailAccount } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import {
  mailThreads,
  type MailThreadRow,
} from "@plugins/apps/plugins/mail/plugins/threads/core";
import { ThreadRow } from "@plugins/apps/plugins/mail/plugins/threads/web";
import {
  mailSearch,
  MAIL_SEARCH_MAX_CHARS,
  type MailSearchHit,
  type MailSearchQuery,
  type MailSearchRefusal,
} from "@plugins/apps/plugins/mail/plugins/sync/core";
import { mailMessagePane, mailSearchPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const starIcon = symbol("star");

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MAIL_SEARCH_VIEW = defineDataView("mail-search");

/**
 * The search surface: a query input over Gmail's ranked answer. The answer is
 * the `mail.search` paged value — ranked THREAD ids, read from Gmail as far as
 * the list scrolls, with every matching envelope folded into the local mirror —
 * so this reaches mail OLDER than the 30-day sync window, unlike the mailbox
 * list. Each hit is drawn as its live `mail.threads` row, so its read / starred
 * state follows the mailbox. Opening a row reads its newest matched message
 * (see the reader pane).
 *
 * Debounce: there is no shared `useDebounced` primitive, so the query is
 * debounced locally (~250ms) with a `setTimeout` in an effect before it drives
 * the search. (Follow-up: promote a `useDebounced` hook to primitives.)
 */
export function MailSearchBody(): ReactElement {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // The account the matches are mirrored under, stated as data (as the
  // threads list states its scope). Not known yet is the loading state; no
  // account yet is the not-connected state.
  const account = useLive(mailAccount);
  // A reconnect flips this, which starts the shown search over (a new round):
  // a search refused `not-connected` is asked again once Gmail is back.
  const { ready: gmailReady } = useGmailAccess();
  const trimmed = debounced.trim();

  return (
    <PaneChrome pane={mailSearchPane}>
      <Column
        fill
        scrollBody={false}
        header={
          <Inset pad="sm">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all mail"
              maxLength={MAIL_SEARCH_MAX_CHARS}
              autoFocus
            />
          </Inset>
        }
        body={matchResource(account, {
          loading: () => <Loading variant="rows" />,
          ready: (a) =>
            a === null ? (
              <GmailAccessEmptyState whenReady="Gmail is connected — search opens once its first sync has run." />
            ) : trimmed.length === 0 ? (
              <Placeholder>
                Search all mail — including messages older than the 30-day sync
                window.
              </Placeholder>
            ) : (
              <SearchResults
                key={`${a.id}\n${trimmed}\n${gmailReady}`}
                q={trimmed}
                accountId={a.id}
              />
            ),
        })}
      />
    </PaneChrome>
  );
}

/** A fresh search round: every search this pane starts asks Gmail anew. */
const mintRound = (): string => crypto.randomUUID();

/**
 * One question's results: the ranked hits, paged by the rows on screen, each
 * drawn as its live thread row. Keyed by the question in the parent, so a new
 * search starts over (loading, as a changed question is a new read) — with a
 * new `round`, so the same query typed again asks Gmail again rather than
 * reading the answer the server held for the last search. "Search again"
 * starts a new round in place.
 */
function SearchResults({
  q,
  accountId,
}: {
  q: string;
  accountId: MailSearchQuery["accountId"];
}): ReactElement {
  const [round, setRound] = useState(mintRound);
  const question = useMemo(
    (): MailSearchQuery => ({ q, accountId, round }),
    [q, accountId, round],
  );
  const openPane = useOpenPane();
  const { pages, paging } = useLivePagedValuePaging<
    MailSearchHit,
    undefined,
    MailSearchQuery,
    MailSearchQuery,
    MailSearchRefusal
  >(mailSearch, question);
  const hits = pages.status === "ready" ? pages.rows : NO_HITS;

  // The hits' thread rows, live: a read or star elsewhere shows here.
  const ids = useMemo(() => hits.map((h) => h.id), [hits]);
  const threads = useLive(mailThreads, { ids });

  // A grown (or released) id set is a new read; while it loads, the rows the
  // previous set read stay on screen — server rows, one read old — rather than
  // the list blinking to its loading state on every page. A failed read is the
  // list's error, held rows or not. Held by hand because `useLive(c, { ids })`
  // has no keep-previous-rows option yet (task-1792607420-9mxb97).
  const [held, setHeld] = useState<readonly MailThreadRow[] | null>(null);
  let shown: readonly MailThreadRow[] | null;
  let rowsReadiness: ResourceReadiness;
  switch (threads.status) {
    case "ready":
      if (held !== threads.data) setHeld(threads.data);
      shown = threads.data;
      rowsReadiness = { status: "ready" };
      break;
    case "loading":
      shown = held;
      rowsReadiness = held === null ? threads : { status: "ready" };
      break;
    case "error":
      shown = null;
      rowsReadiness = threads;
      break;
  }

  const rows = useMemo((): MailThreadRow[] => {
    if (shown === null) return [];
    const byId = new Map(shown.map((t) => [t.id, t]));
    // In rank order; a hit whose thread is gone from the mirror draws nothing.
    return hits.flatMap((h) => {
      const row = byId.get(h.id);
      return row === undefined ? [] : [row];
    });
  }, [hits, shown]);
  const messageOf = useMemo(
    () => new Map(hits.map((h) => [h.id, h.messageId])),
    [hits],
  );

  // Loading until the hits AND their rows are known; a failed (or refused)
  // search or rows read is the list's error.
  const readiness: ResourceReadiness =
    pages.status === "ready" ? rowsReadiness : pages;

  // The open message's thread, so the list highlights the row being read.
  const openMessageId = mailMessagePane.useRouteEntry()?.params.messageId;
  const selectedRowId = hits.find((h) => h.messageId === openMessageId)?.id;

  // A refusal with a fix is drawn with it, not as the list's dead-end error:
  // a lost Gmail connection offers the reconnect, an expired round a new one.
  if (pages.status === "error" && pages.error.kind === "refused") {
    const searchAgain = () => setRound(mintRound());
    switch (pages.error.code) {
      case "not-connected":
        return (
          <SearchRefused
            message={pages.error.message}
            fix={<GmailAccessAction reconnect />}
            onSearchAgain={searchAgain}
          />
        );
      case "expired":
        return (
          <SearchRefused
            message={pages.error.message}
            onSearchAgain={searchAgain}
          />
        );
      case "invalid-cut":
      case undefined:
        // A forged cut is a bug, not the user's to fix: the list's error.
        break;
    }
  }

  return (
    <DataView<MailThreadRow>
      storageKey={MAIL_SEARCH_VIEW}
      rows={rows}
      collection={mailThreads}
      rowKey={(t) => t.id}
      readiness={readiness}
      paging={paging ?? undefined}
      views={["list"]}
      selectedRowId={selectedRowId}
      emptyState="No matches."
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
          renderRow: (t: MailThreadRow): ReactNode => <ThreadRow thread={t} />,
        },
      }}
      rowActivation={(t) => {
        const messageId = messageOf.get(t.id);
        if (messageId === undefined) return;
        openPane.to(
          mailMessagePane,
          { messageId },
          { mode: "push", side: "right" },
        );
      }}
    />
  );
}

/** A refused search: the server's message, the fix when there is one, and Search again. */
function SearchRefused({
  message,
  fix,
  onSearchAgain,
}: {
  message: string;
  fix?: ReactNode;
  onSearchAgain: () => void;
}): ReactElement {
  return (
    <Center axis="both" className="min-h-full">
      <Stack gap="md" align="center" className="max-w-sm text-center">
        <Placeholder>{message}</Placeholder>
        {fix}
        <Button variant="outline" onClick={onSearchAgain}>
          Search again
        </Button>
      </Stack>
    </Center>
  );
}

const NO_HITS: readonly MailSearchHit[] = [];
