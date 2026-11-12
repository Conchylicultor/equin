import { useLive } from "@plugins/network/plugins/live/web";
import { siteMirrorStatus } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/core";
import { SITE_MESSAGES_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";

/**
 * Where this computer's copy of a deployment's messages stands, read from
 * `site-mirror.status`: the list reads the copy only once a whole copy is in
 * place (`copied` — older data stays readable through a failed sync). Before
 * that there is nothing to list, and the freshness line says why (copying,
 * not synced yet, a failed pull).
 */
export type MessagesCopy =
  | { kind: "loading" }
  | { kind: "error"; error: Error; refetch: () => Promise<void> }
  | { kind: "copied" }
  | { kind: "not-copied"; syncing: boolean };

export function useMessagesCopy(deploymentId: string | null): MessagesCopy {
  const status = useLive(
    siteMirrorStatus,
    deploymentId === null ? null : { deploymentId },
  );
  switch (status.status) {
    case "loading":
      return { kind: "loading" };
    case "error":
      return { kind: "error", error: status.error, refetch: status.refetch };
    case "ready": {
      const row = status.data.find(
        (r) => r.setId === SITE_MESSAGES_MIRROR_SET_ID,
      );
      if (row?.copied) return { kind: "copied" };
      return {
        kind: "not-copied",
        // Syncing only while a pull is asked for: a first copy whose pull
        // failed stays `copying` with nothing coming, and the freshness line
        // shows that failure.
        syncing: row?.pending === true,
      };
    }
  }
}
