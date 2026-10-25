import type { ReactNode } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { CURL_EXIT, type HostQueryFailure } from "../../core";

const SSH_FAILURE_TEXT: Record<
  Extract<HostQueryFailure, { kind: "ssh-failed" }>["failure"],
  string
> = {
  dns: "The server's hostname does not resolve.",
  unreachable: "The server refused the connection or cannot be reached.",
  timeout: "The SSH connection timed out.",
  auth: "The server rejected this app's SSH key.",
  "host-key-mismatch":
    "The server presented a different host key than the one pinned — it was reinstalled, or something is intercepting the connection. Check the server's page.",
  "command-failed": "The command on the server failed.",
  unknown: "SSH failed for a reason it did not classify.",
};

/** What the reader was asking for, in the words each sentence needs. */
export interface HostQuerySubject {
  /** What is being read, as a noun phrase: "analytics", "messages". */
  reading: string;
  /** What a good answer is, with its article: "an analytics report". */
  answer: string;
}

function curlExplanation(
  exitCode: number | null,
  subject: HostQuerySubject,
): string {
  switch (exitCode) {
    case CURL_EXIT.couldNotConnect:
      return "Nothing answered on the install's loopback port — the site is not running.";
    case CURL_EXIT.httpError:
      return `The site answered with an error. If it was deployed before its ${subject.reading} were added to its composition, deploy it again.`;
    case CURL_EXIT.timedOut:
      return "The site took too long to answer.";
    case null:
      return "The request on the server was killed before it finished.";
    default:
      return `The request on the server failed (curl exit ${exitCode}).`;
  }
}

/**
 * One error state: the sentence, the raw diagnostic under it, and any action.
 * Rendered as an alert, never as an empty answer.
 */
export function HostQueryErrorState({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <Stack gap="xs" align="start" role="alert">
      <Text as="p" variant="body" tone="destructive">
        {title}
      </Text>
      {detail && (
        <Text
          as="pre"
          variant="code"
          tone="muted"
          className="whitespace-pre-wrap break-all"
        >
          {detail}
        </Text>
      )}
      {children}
    </Stack>
  );
}

/**
 * The body for a host-only read that failed before the box answered: each
 * failure named for what failed and what to do, the raw SSH or curl stderr
 * verbatim under it. Shared by every deploy section that reads its box over
 * SSH, so they speak one vocabulary.
 */
export function HostQueryFailureState({
  failure,
  subject,
}: {
  failure: HostQueryFailure;
  subject: HostQuerySubject;
}): ReactNode {
  switch (failure.kind) {
    case "no-ssh-key":
      return (
        <HostQueryErrorState
          title={`This deployment's server has no SSH key yet, so its ${subject.reading} cannot be read. Set one up on the server's page.`}
        />
      );
    case "unverified":
      return (
        <HostQueryErrorState title="This deployment's server connection was never verified, so its identity is unknown. Verify the connection on the server's page first." />
      );
    case "ssh-failed":
      return (
        <HostQueryErrorState
          title={SSH_FAILURE_TEXT[failure.failure]}
          detail={failure.stderr || failure.message}
        />
      );
    case "request-failed":
      return (
        <HostQueryErrorState
          title={curlExplanation(failure.exitCode, subject)}
          detail={failure.stderr || undefined}
        />
      );
    case "unreadable-answer":
      return (
        <HostQueryErrorState
          title={`The site answered, but not with ${subject.answer}.`}
          detail={failure.detail}
        />
      );
  }
}
