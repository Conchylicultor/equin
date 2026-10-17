import type { ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { DeployRun } from "../../core";

/**
 * A deployment's last run as the row's trailing chip — deliberately one line,
 * because it sits in the list row's rigid trailing region. The full failure text
 * is the `title`, and it also appears in full in {@link RunFailureNotice} above
 * the list; the whole transcript is in the row's pane, under Output.
 */
export function RunCell({ run }: { run: DeployRun | undefined }): ReactElement | null {
  if (!run) return null;

  if (run.status === "running") {
    return (
      <Badge variant="info" icon={<BouncingDots />}>
        {run.verb}
      </Badge>
    );
  }

  const ok = run.status === "succeeded";
  return (
    <Badge
      variant={ok ? "success" : "destructive"}
      tooltip={run.message ?? undefined}
    >
      {run.verb} {ok ? "ok" : "failed"}
    </Badge>
  );
}

/**
 * The most recent failed run on this server, stated in full.
 *
 * This exists because a refusal must **reach the user rather than vanish**. The
 * CLI is where every real verdict is made — a server never verified, a non-Linux
 * host, a composition whose closure carries owner data behind a public hostname,
 * a platform mismatch, a missing bundle, an un-converged host — and it states
 * each one in a sentence written for a human. A chip cannot hold that sentence,
 * so it is repeated here verbatim, unsummarised, until the next run replaces it.
 */
export function RunFailureNotice({
  runs,
}: {
  runs: readonly DeployRun[];
}): ReactElement | null {
  const failed = runs
    .filter((r) => r.status === "failed")
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  const last = failed.at(-1);
  if (!last) return null;

  return (
    <Stack gap="2xs">
      <Text as="p" variant="label" tone="destructive">
        {last.verb} of {last.compositionId} failed
        {/* A null exit code means no CLI process reported one. For a multi-leg
            `update` that is a step which is not a spawn (the release engine, the
            bundle resolution), so the PHASE is what happened — only a phase-less
            run can honestly be called "never started". */}
        {last.exitCode !== null
          ? ` (exit ${last.exitCode})`
          : last.phase
            ? ` during ${last.phase}`
            : " before it started"}
        {last.finishedAt && (
          <>
            {" — "}
            <RelativeTime date={new Date(last.finishedAt)} />
          </>
        )}
      </Text>
      {last.message && (
        <Text as="p" variant="caption" tone="destructive" className="whitespace-pre-wrap">
          {last.message}
        </Text>
      )}
    </Stack>
  );
}
