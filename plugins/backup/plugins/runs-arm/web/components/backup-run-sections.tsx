import type { ReactNode } from "react";

import { GrantAccessButton } from "@plugins/auth/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  BackupSourceItem,
  BackupSourceReport,
  BackupTargetResult,
} from "@plugins/backup/core";
import type { RunRow } from "@plugins/runs/core";
import {
  backupArchiveSize,
  backupSources,
  backupTargetResults,
} from "../internal/payload";
import { formatByteSize } from "@plugins/fields/plugins/byte-size/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkCircleIcon = symbol("check-circle");
const cloudUploadIcon = symbol("cloud-upload");
const errorIcon = symbol("error");
const folderIcon = symbol("folder");

/**
 * One storage target's outcome: the target's icon, its name, a tick or a cross,
 * its own words, and — on a failure the user can actually fix — the button that
 * fixes it.
 *
 * `GrantAccessButton` is the point of this line. It is the **only** in-app
 * repair path for a storage target whose OAuth token expired: without it, a
 * Google Drive backup that lost access reports the failure forever and offers
 * nothing to do about it. Its provider id and scope list come off the target's
 * own `consent` payload, because the grant has to be for the scopes that were
 * actually refused — not for whatever this plugin thinks Drive needs.
 */
function TargetResultLine({
  result,
}: {
  result: BackupTargetResult;
}): ReactNode {
  const icon =
    result.targetId === "google-drive" ? cloudUploadIcon : folderIcon;
  return (
    <Text as="div" variant="body">
      <Inline gap="sm">
        <Icon
          icon={icon}
          className={cn("size-4 text-muted-foreground", rigidClass())}
        />
        <span className="font-medium capitalize">{result.targetId}</span>
        {result.ok ? (
          <Icon icon={checkCircleIcon} className="size-3.5 text-success" />
        ) : (
          <Icon icon={errorIcon} className="size-3.5 text-destructive" />
        )}
        {result.detail !== undefined && (
          <Text as="span" variant="caption" tone="muted">
            {result.detail}
          </Text>
        )}
        {!result.ok && result.consent !== undefined && (
          <GrantAccessButton
            providerId={result.consent.providerId}
            scopes={result.consent.scopes}
            label="Grant access"
            variant="outline"
          />
        )}
      </Inline>
    </Text>
  );
}

function SourceItemLine({ item }: { item: BackupSourceItem }): ReactNode {
  return (
    <Text as="p" variant="caption" tone="muted" className="pl-md">
      {item.label}
      {item.detail !== undefined ? ` — ${item.detail}` : ""}
    </Text>
  );
}

/**
 * One source's report: what it is, the items it contributed, what it
 * deliberately left out, and — when it did not finish — what stopped it.
 *
 * The failure line is the whole reason a failed source is listed here at all
 * rather than dropped with the skipped ones. Its words are the component's own
 * and may run to several lines (the databases source names every database it
 * could not dump), so it wraps rather than truncating: this is the one surface
 * where the detail IS the content.
 */
function SourceReportLines({
  source,
}: {
  source: BackupSourceReport;
}): ReactNode {
  const failed = source.outcome === "failed";
  return (
    <Stack gap="2xs">
      <Text as="p" variant="body" className="font-medium">
        <Inline gap="sm">
          <span>{source.name}</span>
          {failed && (
            <Icon icon={errorIcon} className="size-3.5 text-destructive" />
          )}
        </Inline>
      </Text>
      {source.outcome === "failed" && (
        <Text
          as="p"
          variant="caption"
          tone="destructive"
          className="whitespace-pre-wrap pl-md"
        >
          {source.error}
        </Text>
      )}
      {source.items.map((item, i) => (
        <SourceItemLine key={`${item.label}:${i}`} item={item} />
      ))}
      {source.leftOut !== undefined && source.leftOut.length > 0 && (
        <>
          <Text as="p" variant="caption" className="pl-md font-medium">
            Not backed up
          </Text>
          {source.leftOut.map((item, i) => (
            <SourceItemLine key={`${item.label}:${i}`} item={item} />
          ))}
        </>
      )}
    </Stack>
  );
}

/**
 * What actually went into the archive.
 *
 * The manifest's non-skipped source reports — the same subset the
 * `backup.sourceCount` column counts, because both read the filter from the one
 * decoder. A backup is the run someone audits after the fact, and "2 sources"
 * is not an answer to what was in it.
 */
export function BackupSourcesSection({ run }: { run: RunRow }): ReactNode {
  return (
    <Stack gap="xs">
      {backupSources(run).map((source) => (
        <SourceReportLines key={source.id} source={source} />
      ))}
    </Stack>
  );
}

/**
 * Where the archive was dispatched to, and how each target went.
 *
 * A backup is the one kind of run that can half-succeed — the archive was built
 * and reached two of three targets — so the shared `outcome` alone is not an
 * answer to what happened. This is the per-target reading it stands for, and on
 * a refused OAuth token it is also where the repair lives.
 */
export function BackupTargetsSection({ run }: { run: RunRow }): ReactNode {
  return (
    <Stack gap="xs">
      {backupTargetResults(run).map((result) => (
        <TargetResultLine key={result.targetId} result={result} />
      ))}
    </Stack>
  );
}

/**
 * The collapsed-header verdict of a list section: how many of its entries
 * failed, or that all of them went fine.
 *
 * It sits beside the title, so it is visible whether the card is open or shut.
 * The open state is remembered per section rather than per run — someone who
 * once folded Targets away sees it folded on every later run — so the header,
 * not the body, is the only place a failure is guaranteed to be seen.
 */
function OutcomeSummary({
  failed,
  total,
}: {
  failed: number;
  total: number;
}): ReactNode {
  if (failed === 0) {
    return (
      <Text as="span" variant="body" tone="muted">
        {`${total} of ${total} ok`}
      </Text>
    );
  }
  return (
    <Text as="span" variant="body" tone="destructive">
      <Inline gap="xs">
        <Icon icon={errorIcon} className={cn("size-4", rigidClass())} />
        <span>{`${failed} of ${total} failed`}</span>
      </Inline>
    </Text>
  );
}

/** The Sources header's verdict: how many of the archive's sources failed. */
export function BackupSourcesSummary({ run }: { run: RunRow }): ReactNode {
  const sources = backupSources(run);
  return (
    <OutcomeSummary
      failed={sources.filter((s) => s.outcome === "failed").length}
      total={sources.length}
    />
  );
}

/** The Targets header's verdict: how many targets the archive did not reach. */
export function BackupTargetsSummary({ run }: { run: RunRow }): ReactNode {
  const results = backupTargetResults(run);
  return (
    <OutcomeSummary
      failed={results.filter((t) => !t.ok).length}
      total={results.length}
    />
  );
}

/**
 * How big the archive came out.
 *
 * A one-line section — the whole content is a number, so it declares no
 * `component` and the host paints one static row with no chevron. It is the
 * first thing on the pane because it is the first question asked of a finished
 * backup: a nightly archive that suddenly halved is the signal that a source
 * stopped contributing, and until now the pane listed what went in without ever
 * saying how much came out.
 *
 * The same column the DataView's "Archive size" field reads, through the same
 * accessor, so the line and the column cannot disagree.
 */
export function BackupArchiveSize({ run }: { run: RunRow }): ReactNode {
  const bytes = backupArchiveSize(run);
  // Unreachable through the section's `useAvailable` gate, which is what keeps
  // a run with no archive from painting a titled row over nothing. Stated
  // anyway: the null arm is the type's, not the gate's, to answer.
  if (bytes === null) return null;
  return (
    <Text as="span" variant="body" tone="muted">
      {formatByteSize(bytes)}
    </Text>
  );
}
