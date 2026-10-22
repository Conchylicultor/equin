import type { ReactElement, ReactNode } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  mailHydrateMessageEndpoint,
  mailMessageBody,
  type MailMessageBody,
} from "../../core";

/** A message body that has been fetched and cached: what `ready` renders. */
export type ReadyMailMessageBody = Extract<MailMessageBody, { state: "ready" }>;

/**
 * One message's `mail.message-body` value, every state but the body itself
 * drawn here — so each pane that shows a body (the reading pane, the search
 * reader) renders the same loading and failed-fetch states. The subscription
 * asks for a body not cached yet to be fetched: not fetched yet is the loading
 * state, never an empty body; a failed fetch shows why, with a Retry that asks
 * again (`POST /api/mail/hydrate`). `ready` draws the cached body.
 */
export function MessageBodyState({
  messageId,
  loadingLabel,
  ready,
}: {
  messageId: string;
  /** What the loading state says (none: the bare loading line). */
  loadingLabel?: string;
  ready: (body: ReadyMailMessageBody) => ReactNode;
}): ReactNode {
  const body = useLive(mailMessageBody, { messageId });
  const loading = () => <Loading variant="text" label={loadingLabel} />;
  return matchResource(body, {
    loading,
    ready: (b) => {
      switch (b.state) {
        case "fetching":
          return loading();
        case "failed":
          return <FetchFailed messageId={messageId} error={b.error} />;
        case "ready":
          return ready(b);
      }
    },
  });
}

/** The last fetch of the body failed: why, and a Retry that asks again. */
function FetchFailed({
  messageId,
  error,
}: {
  messageId: string;
  error: string;
}): ReactElement {
  const retry = useEndpointMutation(mailHydrateMessageEndpoint);
  return (
    <Row
      bordered
      actionsAlwaysVisible
      actions={
        <Button
          variant="outline"
          onClick={() => retry.mutateAsync({ body: { messageId } })}
        >
          Retry
        </Button>
      }
    >
      <Text variant="caption" tone="destructive">
        Couldn’t load this message: {error}
      </Text>
    </Row>
  );
}
