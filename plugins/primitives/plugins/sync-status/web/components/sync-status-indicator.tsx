import { useContext, useEffect, useState } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SyncStatusSinkContext } from "../internal/sink-context";
import {
  aggregate,
  SyncStatusStore,
  type SyncAggregate,
} from "../internal/store";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const cloudDoneIcon = symbol("cloud-done");
const cloudOffIcon = symbol("cloud-off");
const syncProblemIcon = symbol("sync-problem");

/** Time the `syncing` state must persist before the spinner shows, so fast saves
 *  never flash (mirrors the `loading` primitive's ~120ms delay-before-show). */
const SYNCING_SHOW_DELAY_MS = 120;

/**
 * The universal per-surface sync-status cloud. Mounted once in `TabSurface`
 * (inside `SyncStatusProvider`), it reads the surface's aggregate and renders a
 * Google-Keep-style status pinned to the surface's bottom-right corner. No app
 * opts in or owns indicator code — reporting (via `useReportSync`) and rendering
 * (here) are both outside any consumer's control.
 */
export function SyncStatusIndicator() {
  const agg = SyncStatusStore.useSelector(
    (s) => aggregate(s),
    [],
    aggregateEqual,
  );
  const showSyncing = useDelayed(agg.kind === "syncing", SYNCING_SHOW_DELAY_MS);

  // Hide the spinner during its show-delay window; everything else is immediate.
  if (agg.kind === "idle") return null;
  if (agg.kind === "syncing" && !showSyncing) return null;

  return (
    // `data-sync-phase` is the machine-readable state (e2e scripts assert on
    // it — the tooltip text is copy, not a contract).
    <Pin to="bottom-right" offset="md" layer="float" data-sync-phase={agg.kind}>
      <Body agg={agg} />
    </Pin>
  );
}

function Body({ agg }: { agg: Exclude<SyncAggregate, { kind: "idle" }> }) {
  const sink = useContext(SyncStatusSinkContext);

  if (agg.kind === "syncing") {
    return (
      <WithTooltip content="Saving…">
        <Spinner className="icon-auto text-muted-foreground" />
      </WithTooltip>
    );
  }

  if (agg.kind === "saved") {
    return (
      <WithTooltip
        content={
          <>
            Saved <RelativeTime date={new Date(agg.at)} />
          </>
        }
      >
        <Icon
          icon={cloudDoneIcon}
          className="icon-auto text-muted-foreground"
        />
      </WithTooltip>
    );
  }

  if (agg.kind === "conflict") {
    // Nothing failed and nothing is in flight: this surface is holding an
    // unsaved edit while the server's copy of the same field moved on. There is
    // no retry to offer — saving is what the surface will do anyway — so this
    // states the divergence and stays out of the way.
    const who = agg.labels.length > 0 ? agg.labels.join(", ") : "This field";
    return (
      <WithTooltip
        content={`${who} changed elsewhere while you were editing — your unsaved version is the one on screen`}
      >
        <Icon icon={syncProblemIcon} className="icon-auto text-warning" />
      </WithTooltip>
    );
  }

  // error — the cloud-off icon doubles as the retry button.
  const labels = agg.labels;
  const what = labels.length > 0 ? ` ${labels.join(", ")}` : "";
  return (
    <IconButton
      icon={cloudOffIcon}
      label="Retry"
      tooltip={`Couldn't save${what} — click to retry`}
      className="text-destructive"
      onClick={() => {
        // Pull every registered retry imperatively and run it.
        for (const ref of sink.retries.values()) ref.current?.();
      }}
    />
  );
}

/**
 * Returns `value` only after it has stayed `true` for `delayMs`; flips back to
 * `false` immediately. Used to suppress the spinner flash on fast saves.
 */
function useDelayed(value: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- animation-temporal-machine: delay-before-show timer (rising/falling edge). The falling-edge setShown(false) and the deferred rising-edge setShown(true) (via setTimeout) are the intended temporal transition that must cause a re-render; the value is not derivable from props at render time (it depends on how long `value` has stayed true) and there is no external store to subscribe to
      setShown(false);
      return;
    }
    const id = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return shown;
}

/** Value-compare the aggregate so the selector bails on equal snapshots. */
function aggregateEqual(a: SyncAggregate, b: SyncAggregate): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "saved" && b.kind === "saved") return a.at === b.at;
  const la = labelsOf(a);
  const lb = labelsOf(b);
  if (la && lb) {
    return la.length === lb.length && la.every((l, i) => l === lb[i]);
  }
  return true;
}

/** The labels an aggregate names, or null for the kinds that name none. */
function labelsOf(agg: SyncAggregate): string[] | null {
  return agg.kind === "error" || agg.kind === "conflict" ? agg.labels : null;
}
