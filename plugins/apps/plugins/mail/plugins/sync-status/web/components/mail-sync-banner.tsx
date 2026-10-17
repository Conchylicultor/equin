import type { ReactElement, ReactNode } from "react";
import {
  MAIL_SYNC_REMEDIATION,
  type MailSyncErrorCode,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailSyncEndpoint } from "@plugins/apps/plugins/mail/plugins/sync/core";
import { GmailAccessAction } from "@plugins/integrations/plugins/gmail/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useMailSyncState } from "../internal/use-mail-sync";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

const errorIcon = symbol("error");
const warningIcon = symbol("warning");

/**
 * The Mail app's sync-status banner. Renders a single compact, full-width strip
 * above the mailbox surface for the unhealthy phases and stays out of the way
 * (returns `null`) while everything is fine — the landing pane owns the calm
 * "last synced" line. All copy / remediation comes from the shared
 * `MAIL_SYNC_REMEDIATION` map keyed by the classified error code.
 */
export function MailSyncBanner(): ReactElement | null {
  const sync = useMailSyncState();

  // Loading, or all-clear: the banner is silent (the landing shows "last synced").
  if (sync.status === "loading") return null;
  // The sync state itself failed to load: say so, with its retry — silence
  // would read as "all clear".
  if (sync.status === "error") {
    return (
      <BannerShell
        tone="warning"
        icon={<Icon icon={warningIcon} className="size-4" />}
        title={
          <ResourceErrorInline
            variant="inline"
            subject="the mail sync status"
            error={sync.error}
            refetch={sync.refetch}
          />
        }
      />
    );
  }
  const view = sync.data;
  if (view.phase === "healthy" || view.phase === "idle") return null;

  if (view.phase === "syncing") {
    return (
      <BannerShell
        tone="info"
        icon={<Spinner />}
        title="Syncing your mailbox…"
      />
    );
  }

  // warning | error — both carry a classified error; fall back to "unknown".
  const code: MailSyncErrorCode = view.error?.code ?? "unknown";
  const remediation = MAIL_SYNC_REMEDIATION[code];

  // The recorded technical reason ("…needs consent (missing-scopes)"). Shown as
  // a muted detail line under the remediation copy: the human copy says what to
  // do, this says what the server actually saw — which is the difference between
  // a diagnosable banner and a shrug, especially for the `unknown` code.
  const detail = view.error?.message;

  // Both unhealthy phases offer the SAME actions, driven only by the classified
  // code's remediation — the phase decides how loud the banner looks, never
  // whether the user is given a way out. (Keying the fix affordance off `error`
  // alone would silently strip it the day a reconnect-able failure is classified
  // as non-terminal.)
  const actions = <RemediationActions remediation={remediation} />;

  if (view.phase === "warning") {
    return (
      <BannerShell
        tone="warning"
        icon={<Icon icon={warningIcon} className="size-4" />}
        title={remediation.title}
        body={remediation.body}
        detail={detail}
        actions={actions}
      />
    );
  }

  // error — terminal until the user acts.
  return (
    <BannerShell
      tone="error"
      icon={<Icon icon={errorIcon} className="size-4" />}
      title={remediation.title}
      body={remediation.body}
      detail={detail}
      actions={actions}
    />
  );
}

/**
 * The remediation-specific control that actually resolves the failure, plus the
 * manual retry as the secondary. Leading with the fix (rather than sending the
 * user to Settings to work out what to change) is the whole point: `reconnect`
 * opens Google's consent popup in place, and granting auto-resumes sync via
 * `sync/auto-resume`'s ready-edge watcher — no second trip back here.
 */
function RemediationActions({
  remediation,
}: {
  remediation: (typeof MAIL_SYNC_REMEDIATION)[MailSyncErrorCode];
}): ReactElement {
  const learnMoreUrl = remediation.learnMoreUrl;
  return (
    <>
      {remediation.action === "reconnect" ? (
        // Mail never imports `@plugins/auth` — the Gmail integration brokers the
        // connect/grant flow. `reconnect` forces the grant affordance even when
        // local state looks healthy: the server saw an auth failure the
        // browser's cached scope list can't see.
        <GmailAccessAction reconnect />
      ) : null}
      {remediation.action === "enable-api" && learnMoreUrl ? (
        <NewTabButton href={learnMoreUrl} variant="outline">
          Enable Gmail API
        </NewTabButton>
      ) : null}
      <RetryButton />
    </>
  );
}

/**
 * "Sync now" trigger. A failure the user can act on comes back as a 409 whose
 * body is the remediation copy (see the sync plugin's `handleMailSync`), so the
 * global auto-toast reads as a sentence rather than "HTTP 500"; a genuine bug
 * still 500s and files a crash report.
 */
function RetryButton(): ReactElement {
  const sync = useEndpointMutation(mailSyncEndpoint);
  return (
    <Button
      variant="ghost"
      loading={sync.isPending}
      onClick={() => sync.mutate({})}
    >
      Retry now
    </Button>
  );
}

type BannerTone = "info" | "warning" | "error";

// Tonal banner idiom (border-b + `bg-<tone>/10` + `text-<tone>`): a full-width
// strip whose icon/title/body inherit the tone via `currentColor`. `info` stays
// neutral-muted so an in-progress sync reads as calm, not alarming.
const TONE_CLASS: Record<BannerTone, string> = {
  info: "border-border bg-muted/60",
  warning: "border-warning/50 bg-warning/10 text-warning",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
};

function BannerShell({
  tone,
  icon,
  title,
  body,
  detail,
  actions,
}: {
  tone: BannerTone;
  icon: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** The raw server-recorded reason, rendered muted under `body`. */
  detail?: ReactNode;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("border-b px-md py-sm", TONE_CLASS[tone])}
    >
      <Stack direction="row" gap="sm" align="center">
        {icon}
        <Fill>
          <Stack gap="2xs">
            <Text variant="label">{title}</Text>
            {body != null ? <Text variant="caption">{body}</Text> : null}
            {detail != null ? (
              <Text variant="caption" tone="muted">
                {detail}
              </Text>
            ) : null}
          </Stack>
        </Fill>
        {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- banner remediation buttons, one per mailbox, not a per-row cluster */}
        {actions != null ? <Inline gap="xs">{actions}</Inline> : null}
      </Stack>
    </div>
  );
}
