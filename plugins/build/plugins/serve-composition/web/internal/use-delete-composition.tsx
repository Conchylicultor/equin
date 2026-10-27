import { useCallback } from "react";
import { useManifestActions } from "@plugins/plugin-meta/plugins/composition/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLiveReader } from "@plugins/network/plugins/live/web";
import { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { OwnedNamespacesList } from "../components/owned-namespaces-list";
import {
  reclaimCompositionNamespaces,
  type ReclaimOutcome,
} from "../../shared/endpoints";
import { serveOwned } from "../../shared/serve-owned";

export interface DeleteCompositionRequest {
  /** The manifest item's **id** — what the marker records, never the display name. */
  id: string;
  /** The display name, for the dialog and the toasts. */
  name: string;
  /**
   * Called once the row is actually gone — never on cancel, and never when a
   * reclaim failed. The detail pane uses it to clear its draft and close.
   */
  onDeleted?: () => void;
}

/**
 * Deleting a composition — the whole concept, in one place.
 *
 * A composition is not just a config row: building it mints a namespace, and a
 * namespace is a live address, a Postgres database, a config dir and a built
 * frontend. Dropping the row alone leaves all of that on disk forever AND makes
 * it invisible, because every composition-aware surface is keyed off the row that
 * just vanished. So this asks the server what the composition owns, shows the
 * person exactly what they are about to lose, and gives it back before removing
 * the row.
 *
 * `remove(id)` in `plugin-meta/composition` stays the pure synchronous config
 * edit its name promises. Burying a reclaim inside it would put "delete
 * everything this composition owns" in a function whose call sites think they
 * are editing an array; the concept lives here instead, and both Studio delete
 * buttons call this, so they cannot drift.
 *
 * The inventory is `build.serve-owned`, read with `useLiveReader` at the click:
 * a snapshot, measured when asked, so the dialog names what is there now.
 *
 * The returned function rejects only on a bug (anything the reader throws that
 * is not its `ResourceError`): `Button` auto-pends off a returned thenable but
 * attaches only `.finally()`, so a rejection escapes as an unhandled rejection —
 * every expected failure is a toast instead. It awaits only the inventory read (so the button pends
 * while we find out what is at stake, rather than rendering "owns nothing"
 * before we know) and then hands off to the dialog, which owns its own lifetime,
 * its own error display and its own retry.
 */
export function useDeleteComposition(): {
  deleteComposition: (req: DeleteCompositionRequest) => Promise<void>;
} {
  const read = useLiveReader();
  const { remove } = useManifestActions();
  // The dialog shows the failure inline and re-enables its confirm button, so it
  // IS the error surface; a global toast on top of it would say the same thing
  // twice.
  const reclaim = useEndpointMutation(reclaimCompositionNamespaces, {
    meta: { suppressError: true },
  });

  // Read at CALL time, not captured at render time: the dialog can stay open for
  // as long as the person reads it, and `remove` closes over the manifest array
  // it saw when it was created — a stale one would resurrect rows edited
  // meanwhile.
  const latest = useLatestRef({ remove, reclaim: reclaim.mutateAsync });

  const deleteComposition = useCallback(
    async ({
      id,
      name,
      onDeleted,
    }: DeleteCompositionRequest): Promise<void> => {
      // Stop, loudly, and change nothing on any answer but the inventory.
      // Deleting the row without knowing what it owns is the exact bug this
      // hook exists to prevent, so a failed read is a refusal to delete, not a
      // reason to fall back to the old one-line behaviour.
      const refuse = (why: string) =>
        showToast({
          title: `Did not delete “${name}”`,
          description: `Could not check what it is serving: ${why}`,
          variant: "error",
        });
      let answer;
      try {
        answer = await read(serveOwned, { composition: id });
      } catch (err) {
        // The reader has already filed the failure through the live read error
        // sink; this is the part the person sees.
        if (!(err instanceof ResourceError)) throw err;
        refuse(err.message);
        return;
      }
      if (answer.status === "unavailable") {
        refuse(answer.message);
        return;
      }
      const owned = answer.data.namespaces;

      // Nothing was ever built from this composition, so there is nothing to
      // warn about and nothing to reclaim — deleting the row destroys only the
      // row. A confirm dialog here would be a scary prompt with an empty list
      // behind it, which teaches people to click through the one that matters.
      if (owned.length === 0) {
        latest.current.remove(id);
        onDeleted?.();
        return;
      }

      // Fire-and-forget by design: awaiting the dialog would auto-pend the
      // launching button for as long as it stays open.
      void confirmDialog({
        title: `Delete “${name}” and erase what it is serving?`,
        description: (
          <>
            This composition is live. Deleting it takes down the{" "}
            {owned.length === 1 ? "address" : "addresses"} below and erases the
            data behind {owned.length === 1 ? "it" : "them"} — the database and
            the saved settings. That cannot be undone.
          </>
        ),
        children: <OwnedNamespacesList namespaces={owned} />,
        confirmLabel: "Delete and erase",
        onConfirm: async () => {
          const { results } = await latest.current.reclaim({ body: { id } });
          const failures = results.filter(
            (r) => r.outcome.kind !== "reclaimed",
          );
          if (failures.length > 0) {
            // The row is the only remaining handle on a namespace that did not
            // come back, so it STAYS — removing it now is precisely how a
            // stranded namespace becomes invisible. Throwing keeps the dialog
            // open with the reason on screen, so the retry is one click away.
            throw new Error(
              `Kept “${name}”: ${failures
                .map((f) => `${f.namespace} — ${describeFailure(f.outcome)}`)
                .join("; ")}`,
            );
          }
          latest.current.remove(id);
          onDeleted?.();
          showToast({
            title: `Deleted “${name}”`,
            description: `Reclaimed ${results.map((r) => r.namespace).join(", ")}.`,
            variant: "success",
          });
        },
      });
    },
    [read, latest],
  );

  return { deleteComposition };
}

/** A refusal and a half-done reclaim need different fixes, so they read differently. */
function describeFailure(outcome: ReclaimOutcome): string {
  switch (outcome.kind) {
    case "refused":
      return `refused, nothing touched (${outcome.reason})`;
    case "failed":
      return `failed part-way (${outcome.message})`;
    case "reclaimed":
      // Unreachable — filtered out above — but stated rather than defaulted, so
      // a new outcome arm is a type error here instead of a silent "ok".
      return "reclaimed";
  }
}
