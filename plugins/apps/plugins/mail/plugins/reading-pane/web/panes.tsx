import { type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { mailApp } from "@plugins/apps/plugins/mail/plugins/shell/core";
import { threadMessages } from "../core";
import { MessageList } from "./components/message-list";

// The reading pane: the second Miller column, opened by selecting a thread in the
// list (`openPane(threadPane, { threadId }, { mode: "push" })`). Exported so the
// threads plugin can reference it for selection + navigation. Registered via
// `Pane.Register` in the default plugin definition (`index.ts`).
export const threadPane = Pane.define({
  route: defineRoute({ id: "mail-thread", segment: "thread/:threadId" }),
  app: mailApp,
  component: ThreadPaneView,
  width: 640,
  // No existence gate: a missing/deleted thread resolves to an empty message
  // list ("(no subject)") rather than a hard 404 — the list only ever opens
  // thread ids it just rendered.
  useResolve: false,
  title: { useText: useThreadTitle, fallback: "Thread" },
});

/** The thread's subject once its messages load; undefined until then. */
function useThreadTitle({
  threadId,
}: {
  threadId: string;
}): string | undefined {
  // The same query the pane body reads (newest first), so its first page is the
  // body's page 0 subscription. This read never pages: the body's "Load older
  // messages" adds pages to the body's own read, and the title stays on page 0.
  const result = useLive(threadMessages, { where: { threadId } });
  switch (result.status) {
    case "loading":
    case "error":
      return undefined;
    case "ready":
      break;
  }
  // The subject is stable across a thread; page 0's oldest message carries it
  // (in a thread longer than one page that is a reply, so its "Re:" form).
  return result.data.at(-1)?.subject?.trim() || "(no subject)";
}

function ThreadPaneView(): ReactNode {
  const { threadId } = threadPane.useParams();
  // The thread's newest messages (the collection's default window is newest
  // first); `loadMore` pages backwards in time.
  const result = useLive(threadMessages, { where: { threadId } });

  if (result.status === "loading") {
    return (
      <PaneChrome pane={threadPane}>
        <Loading variant="rows" />
      </PaneChrome>
    );
  }
  if (result.status === "error") {
    return (
      <PaneChrome pane={threadPane}>
        <ResourceErrorInline
          variant="block"
          subject="this thread"
          error={result.error}
          refetch={result.refetch}
        />
      </PaneChrome>
    );
  }

  return (
    <PaneChrome pane={threadPane}>
      <MessageList newestFirst={result.data} older={result} />
    </PaneChrome>
  );
}
