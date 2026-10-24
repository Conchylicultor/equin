import { useEffect, useRef, type ReactElement } from "react";
import {
  useGmailAccess,
  GmailAccessEmptyState,
} from "@plugins/integrations/plugins/gmail/web";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { mailApp } from "../../core";

/**
 * Mail's index surface (bare `/mail`). It reads the Gmail integration's
 * connection state (never `@plugins/auth` directly) and renders the appropriate
 * empty-state until the mailbox is ready; once ready it redirects to the threads
 * surface, so the user lands straight in the mailbox rather than on a static
 * "connected" card.
 */
export function MailRoot(): ReactElement {
  const goToApp = useNavigate();
  const { blocker, loading, ready, error, refetch } = useGmailAccess();

  // Fire the mailbox redirect exactly once per mount, on the edge where the
  // mailbox becomes ready. Navigate by URL LITERAL (not the pane object) so this
  // shell never imports the threads plugin — `threads → shell` stays one-way and
  // acyclic. `/mail/threads` mounts `mailThreadsPane` as the Miller root exactly
  // like `openPane(mailThreadsPane, {}, { mode: "root" })`; which mailbox opens
  // there is the DataView's own tab selection, not part of the URL.
  const redirected = useRef(false);
  useEffect(() => {
    if (ready && !redirected.current) {
      redirected.current = true;
      goToApp(`${mailApp.basePath}/threads`);
    }
  }, [ready, goToApp]);

  if (loading) {
    return (
      <Center axis="both" className="min-h-full">
        <Loading variant="spinner" />
      </Center>
    );
  }

  if (error !== null) {
    return (
      <Center axis="both" className="min-h-full">
        <ResourceErrorInline
          variant="block"
          subject="the Gmail connection state"
          error={error}
          refetch={refetch}
        />
      </Center>
    );
  }

  // One empty state for every unmet prerequisite: the integration names the
  // blocker, supplies its copy, and renders the control that resolves it right
  // here — so the landing is never a dead end telling the user to go and find
  // the fix in Settings themselves.
  if (blocker != null) return <GmailAccessEmptyState title="Mail" />;

  // ready — the effect above swaps the route to the threads surface; show a
  // spinner for the frame before it lands.
  return (
    <Center axis="both" className="min-h-full">
      <Loading variant="spinner" />
    </Center>
  );
}
