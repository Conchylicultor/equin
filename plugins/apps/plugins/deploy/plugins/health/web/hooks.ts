import { useMemo } from "react";
import {
  mapRow,
  useLive,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { serverHealthRows, type ServerHealthRow } from "../shared";

/**
 * `Map<serverId, row>` for EXACTLY the given server ids, over the collection's
 * `:rows` point sibling — no window truncates a point-set read, so a caller
 * showing every server just passes every server's id (e.g. from
 * `deploy/servers`'s own whole-set `servers` value) rather than reading the
 * collection's bounded default window and hoping it covers the same rows.
 *
 * `loading` until the read lands (`error` if it failed) — never an empty map:
 * an absent entry means "never checked", which is a claim about the server that
 * a read still loading cannot make. `serverIds` itself may come from a
 * still-loading resource (the caller passes `[]` meanwhile); combine that
 * resource with this one via `useCombinedResources` so the map is ready only
 * when BOTH land.
 * Each caller decides what its surface shows meanwhile.
 */
export function useServerHealthMap(
  serverIds: readonly string[],
): ResourceResult<ReadonlyMap<string, ServerHealthRow>> {
  const result = useLive(serverHealthRows, { ids: serverIds });
  return useMemo(
    () =>
      mapResource(result, (rows) => new Map(rows.map((r) => [r.serverId, r]))),
    [result],
  );
}

/**
 * The last probe verdict for one server: `loading`, `error` if the read failed,
 * then
 * `found: true` with the row, or `found: false` — the server has never been
 * checked.
 */
export function useServerHealth(
  serverId: string,
): LiveRowResult<ServerHealthRow> {
  return useLive(serverHealthRows, { id: serverId });
}

/**
 * Whether the server's *current* key is proven to work, from a verdict already
 * in hand (`null`: never checked): the last probe succeeded AND it was run
 * against the key the server carries right now.
 *
 * The second half is what makes this exact with no cross-plugin write —
 * replacing the key changes `sshKey.publicKey`, the comparison fails, and every
 * consumer (the verify step, the setup flow) drops back to unverified on its
 * own.
 *
 * A server we hold no *identifiable* key for (`sshKey === null`) compares its
 * `null` against whatever the probe recorded: a probe that ran against a real
 * key is correctly no longer proof, and a probe that also recorded `null` (a
 * pre-`sshKey` row) compares equal, which is the honest reading — the same key
 * is still installed, we just can't name it.
 */
export function isKeyVerified(
  row: ServerHealthRow | null,
  server: Server,
): boolean {
  return (
    row !== null &&
    row.ok &&
    row.checkedPublicKey === (server.sshKey?.publicKey ?? null)
  );
}

/** {@link isKeyVerified} for one server, read live. */
/**
 * Whether the server's current key is proven to work, as a read: `loading`
 * while the verdict is still loading, `error` (with Retry) when its read
 * failed — each caller decides for itself what its surface shows then, rather
 * than reading either as "not verified" — and on the ready arm the verdict.
 */
export function useServerVerified(server: Server): ResourceResult<boolean> {
  const health = useServerHealth(server.id);
  return useMemo(
    () => mapRow(health, (row) => isKeyVerified(row, server)),
    [health, server],
  );
}
