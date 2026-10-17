import { useRef, type ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  ToggleChip,
  SegmentedControl,
  type SegmentedOption,
} from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  isServableCompositionId,
  isServed,
  serveModeLabel,
  autoRebuildIntervalMs,
  SERVE_MODE_OPTIONS,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { useServeComposition } from "../internal/use-serve-composition";
import type { ServeStatus } from "../internal/use-serve-status";
import { resetCompositionData } from "../../shared/endpoints";

/**
 * The modes the picker offers: every one but `off`. Switching the serve off is
 * the `ToggleChip`'s job, and an "off" segment beside it would be a second
 * control for the same fact — two controls that can disagree about one state.
 *
 * Typed at `string` rather than `ServeMode` because the stored field IS a
 * `string` (`enumField` types it so, and the config's zod enum is what narrows
 * it on read), so neither the value this reads nor the mode it writes needs a
 * cast.
 */
const REBUILD_MODE_OPTIONS: readonly SegmentedOption<string>[] =
  SERVE_MODE_OPTIONS.filter((option) => isServed(option.value)).map(
    (option) => ({ id: option.value, label: option.label }),
  );

/**
 * The **Serve live** target panel — the one control for a composition's local
 * deploy, and the one honest statement of whether it is live.
 *
 * Two facts are deliberately kept apart here, because collapsing them is what
 * produced links to namespaces that 502:
 *
 * - **intent** — `item.serve`, the mode the `ToggleChip` and the rebuild picker
 *   write into config. Anything but `off` says the composition is meant to be
 *   live here; the automatic modes add only a rate limit on rebuilding it.
 * - **liveness** — the `status` prop, resolved from the `composition.json`
 *   marker a serve build actually wrote. Only this may produce a link, and only
 *   it knows the namespace: a composition is served from whichever checkout
 *   built it, so the host is server-resolved rather than composed here.
 *
 * `status` is a prop rather than a hook call so a host that already needs the
 * answer for an affordance of its own (a list row's shortcut, say) asks once and
 * hands the same snapshot to the panel.
 */
export function ServeTargetPanel({
  item,
  status,
}: {
  item: CompositionManifestItem;
  status: ServeStatus;
}): ReactElement {
  const { setMode, rebuildNow } = useServeComposition();
  // Reset the served composition's own DB + config back to first-launch. Handles
  // its own toasts (success + failure) so `onError` suppresses the global one.
  const reset = useEndpointMutation(resetCompositionData, {
    onError: (err) =>
      showToast({
        description: `Reset failed: ${err.message}`,
        variant: "error",
      }),
  });

  const served = isServed(item.serve);
  // The mode to come back to when the chip is switched on again. Captured at the
  // moment it is switched OFF — config stores one mode, so `off` genuinely
  // erases which of the five it was, and turning the serve off then on again
  // must not silently demote an hourly rebuild to manual. Written in an event
  // handler only, never in render; `"manual"` is the answer when this panel
  // never saw the row served (a fresh mount, or a mode set elsewhere).
  const lastServedMode = useRef<string>("manual");

  const live =
    status.kind === "ready" && status.live.served
      ? { ...status.live, url: status.url }
      : null;
  // The namespace this composition is served under, as the SERVER resolved it
  // from its own checkout — `sonata` from main, `sonata.att-x` from a worktree.
  // Null while the read is in flight, which is the honest state: the panel does
  // not know the address yet and must not invent one, so the copy below falls
  // back to the composition's own name.
  const host = status.kind === "ready" ? status.host : null;
  // The one permanent reason the control cannot work, and it is about the
  // COMPOSITION rather than the backend: a serve may never provision main's
  // namespace, because that namespace is where the checkout's own
  // `./singularity build` deploys. A live button whose only outcome is an error
  // toast is the "upcoming step rendered inert" rule applied to a chip.
  //
  // There is no longer a second, backend-shaped reason. Serving used to run
  // inside MAIN's build, so every other backend could only observe and the
  // server answered `canServe` for it; a serve is now an ordinary build of this
  // checkout, so the question collapses into this one — synchronous, and true
  // before the liveness read has even settled.
  const canServe = isServableCompositionId(item.id);

  return (
    <Stack gap="sm">
      <Stack direction="row" align="center" gap="sm">
        <ToggleChip
          active={served}
          disabled={!canServe}
          tooltip={
            !canServe
              ? "The main app is built by ./singularity build — it is not served as a composition."
              : served
                ? `${serveModeLabel(item.serve)} — click to stop serving`
                : host !== null
                  ? `Click to build & serve this composition at ${host}`
                  : "Click to build & serve this composition from this checkout"
          }
          onClick={() => {
            if (served) {
              lastServedMode.current = item.serve;
              setMode(item.id, "off");
            } else {
              setMode(item.id, lastServedMode.current);
            }
          }}
        >
          {served ? "Serving" : "Serve"}
        </ToggleChip>
        {live && host !== null && (
          <>
            <LinkChip
              mono
              tooltip={`Open ${live.url}`}
              activation={() => {
                window.open(live.url, "_blank", "noopener");
              }}
            >
              {host}
            </LinkChip>
            <Badge variant="muted" mono tooltip={live.commit ?? undefined}>
              {live.commit ? live.commit.slice(0, 7) : "no commit recorded"}
            </Badge>
            <Badge variant="muted">
              built <RelativeTime date={new Date(live.builtAt)} />
            </Badge>
          </>
        )}
        {/* Available in EVERY mode, `push` and the cadences included: the
            automatic gate is blind to an edit of this composition's own manifest
            row, which changes what should be served without moving the commit it
            compares. Keyed on the intent rather than on liveness, so it is also
            how you retry a first serve build that failed. */}
        {served && canServe && (
          <Button
            variant="outline"
            tooltip={
              host !== null
                ? `Build this composition now and republish ${host}`
                : "Build this composition now from this checkout"
            }
            onClick={() => rebuildNow(item.id)}
          >
            Rebuild now
          </Button>
        )}
        {/* No Reset for a non-servable namespace. `resetCompositionData`
            refuses it at its first guard (assertServableCompositionNamespace),
            so the button could only ever produce an error toast — offering it
            is worse than not offering it. */}
        {live && host !== null && canServe && (
          <Button
            variant="destructive"
            aspect="text"
            loading={reset.isPending}
            tooltip={`Wipe ${host}'s database and config back to first-launch (main is untouched)`}
            onClick={() => {
              // Fire-and-forget: confirmDialog owns the dialog lifetime and the
              // keep-open-on-failure retry. `loading={reset.isPending}` reflects
              // the actual reset instead of the dialog's open lifetime.
              void confirmDialog({
                title: `Reset ${host} to first-launch?`,
                description: (
                  <>
                    This wipes this composition&apos;s database and config so
                    you see exactly what a new user gets. The main app&apos;s
                    data (the <code>singularity</code> database and its config)
                    is not touched.
                  </>
                ),
                confirmLabel: "Reset to first-launch",
                onConfirm: async () => {
                  await reset.mutateAsync({ body: { id: item.id } });
                  showToast({
                    description: `Reset ${host} to first-launch.`,
                    variant: "success",
                  });
                },
              });
            }}
          >
            Reset
          </Button>
        )}
      </Stack>
      {/* Only while the composition is served: the modes say WHEN a served
          composition may be rebuilt, so there is nothing for them to mean while
          nothing is meant to be live. */}
      {served && canServe && (
        <Stack gap="xs">
          <Stack direction="row" align="center" gap="sm">
            <Text variant="label" tone="muted">
              Rebuild
            </Text>
            <SegmentedControl
              options={REBUILD_MODE_OPTIONS}
              value={item.serve}
              onChange={(mode) => setMode(item.id, mode)}
              variant="ghost"
            />
          </Stack>
          <Text as="p" variant="caption" tone="muted">
            An automatic rebuild runs only when this checkout’s commit has moved
            past the one {host ?? item.id} was built from, so a repo nobody is
            committing to costs nothing whichever mode is picked. Editing this
            composition’s own contributors or entry points does not move the
            commit — <strong>Rebuild now</strong> is how you publish that.
          </Text>
        </Stack>
      )}
      <ServeStatusNote item={item} status={status} />
      <Text as="p" variant="caption" tone="muted">
        {canServe ? (
          <>
            Serving runs{" "}
            <code>./singularity build --composition {item.id}</code> in THIS
            checkout: its own frontend dist and empty database, live at{" "}
            {host ?? `${item.id}.<this checkout>`}. Two checkouts serving the
            same composition get two namespaces and two databases.
          </>
        ) : (
          <>
            This is the app this repo builds. It is deployed by{" "}
            <code>./singularity build</code> into this checkout’s own namespace,
            so there is nothing here to switch on.
          </>
        )}
      </Text>
    </Stack>
  );
}

/**
 * The sentence for whatever intent and liveness currently disagree about — the
 * states a `serve`-only surface used to render as a flat "Serving".
 */
function ServeStatusNote({
  item,
  status,
}: {
  item: CompositionManifestItem;
  status: ServeStatus;
}): ReactElement | null {
  if (status.kind === "pending") {
    return (
      <Text as="p" variant="caption" tone="muted">
        Checking what is actually served…
      </Text>
    );
  }
  if (status.kind === "error") {
    // Loud, not swallowed: an unreadable marker means this surface cannot say
    // whether the namespace is live, and it must not imply that it is.
    return (
      <Text as="p" variant="caption" tone="destructive">
        Could not read the serve state: {status.message}
      </Text>
    );
  }
  const served = isServed(item.serve);
  // Ordered by urgency, and this arm wins over the trigger note below on
  // purpose: while nothing is served yet, "the build has not finished" is what
  // the person is waiting on — where the automatic triggers run is a standing
  // fact they can read once there is something to rebuild.
  if (served && !status.live.served) {
    return (
      <Text as="p" variant="caption" tone="muted">
        Enabled, but nothing is served at {status.host} yet — the serve build
        has not finished (or it failed).
      </Text>
    );
  }
  if (!served && status.live.served) {
    // Deliberately NOT "the next main build stops serving it": nothing takes a
    // served namespace down on its own, because deactivation is never a reclaim
    // trigger. Deleting the composition is what reclaims the namespace — that is
    // the flow `useDeleteComposition` runs, and it is the one this sentence has
    // to point at, or the namespace looks unrecoverable.
    return (
      <Text as="p" variant="caption" tone="muted">
        The serve intent is off, but {status.host} is still live from an earlier
        build. Deleting the composition is what takes it down and gives its
        database and config back.
      </Text>
    );
  }
  // The mode promises an automatic rebuild that this backend does not run.
  // Offering "On every push" from a worktree and never acting on it is the same
  // lie as a link to a namespace that 502s, so the panel says so instead.
  if (autoRebuildIntervalMs(item.serve) !== null && !status.autoTriggersHere) {
    return (
      <Text as="p" variant="caption" tone="muted">
        Automatic rebuilds run from the main checkout only, so nothing here will
        rebuild {status.host} on its own — from this checkout,{" "}
        <strong>Rebuild now</strong> is what refreshes it.
      </Text>
    );
  }
  return null;
}
