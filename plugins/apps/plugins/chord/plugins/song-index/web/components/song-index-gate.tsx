import { useEffect, type ReactNode } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { matchResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Meter } from "@plugins/primitives/plugins/css/plugins/meter/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  chordIndexStatus,
  ensureChordIndexEndpoint,
  type IndexStatus,
} from "../../core";

type LoadingStatus = Extract<IndexStatus, { kind: "loading" }>;

/**
 * Renders `children` once the song index is ready, and the load's progress
 * until then.
 *
 * Mounting it opens the index (`POST /api/chord/index/ensure`, idempotent: it
 * starts a load only when the index is missing, stale or failed). What it shows
 * comes from the live status, `chord.index-status`, never from the ensure
 * call's answer — so a load started elsewhere is followed the same way.
 */
export function SongIndexGate({ children }: { children: ReactNode }) {
  // The failure is shown in place, with Retry — no toast on top of it.
  const ensure = useEndpointMutation(ensureChordIndexEndpoint, {
    meta: { suppressError: true },
  });
  const { mutate } = ensure;
  useEffect(() => {
    mutate({});
  }, [mutate]);
  const status = useLive(chordIndexStatus);
  const retry = () => mutate({});

  if (ensure.isError) {
    return (
      <GateFrame>
        <GateFailure
          message={ensure.error.message}
          retrying={ensure.isPending}
          onRetry={retry}
        />
      </GateFrame>
    );
  }

  return matchResource(status, {
    loading: () => <Loading />,
    error: (err) => (
      <GateFrame>
        <GateFailure
          message={err.message}
          retrying={false}
          onRetry={() => void status.refetch()}
        />
      </GateFrame>
    ),
    ready: (s) => {
      switch (s.kind) {
        case "ready":
          return children;
        // `ensure` is on its way; the status moves to `loading` when it lands.
        case "not-requested":
          return <Loading />;
        case "loading":
          return (
            <GateFrame>
              <LoadProgress status={s} />
            </GateFrame>
          );
        case "failed":
          return (
            <GateFrame>
              <GateFailure
                message={s.error}
                retrying={ensure.isPending}
                onRetry={retry}
              />
            </GateFrame>
          );
      }
    },
  });
}

function GateFrame({ children }: { children: ReactNode }) {
  return (
    <Inset pad="lg" className="h-full">
      <Center className="h-full">
        <Stack gap="sm" className="w-80 max-w-full">
          {children}
        </Stack>
      </Center>
    </Inset>
  );
}

const PHASE_LABEL: Record<LoadingStatus["phase"], string> = {
  queued: "Waiting to start…",
  downloading: "Downloading songs…",
  "building-snapshot": "Preparing songs…",
  loading: "Loading songs…",
};

function LoadProgress({ status }: { status: LoadingStatus }) {
  const { phase, done, total } = status;
  const counted = phase === "loading" && done !== null && total !== null;
  return (
    <>
      <Text variant="label" tone="muted">
        {counted
          ? `Loading songs ${done.toLocaleString()} / ${total.toLocaleString()}`
          : PHASE_LABEL[phase]}
      </Text>
      {counted && <ProgressBar done={done} total={total} />}
    </>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <Meter
      value={total > 0 ? done / total : 0}
      label="Songs loaded"
      role="progressbar"
      valueText={`${done.toLocaleString()} of ${total.toLocaleString()}`}
    />
  );
}

function GateFailure({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      <Text variant="label">The songs could not be loaded.</Text>
      <Text variant="caption" tone="destructive" className="break-words">
        {message}
      </Text>
      <Stack gap="none" align="start">
        <Button variant="secondary" loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      </Stack>
    </>
  );
}
