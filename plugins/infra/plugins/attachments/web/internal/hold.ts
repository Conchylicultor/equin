import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { holdAttachmentsEndpoint } from "../../shared/endpoints";

// Keep exactly `ids` alive on behalf of `holder` (an unsent draft the server
// cannot see) for `ttlMs` from now — `null` until released. Replaces the
// holder's previous set; an empty `ids` releases it. Over the caller's
// transport (`fetchEndpoint`, its `useFetchEndpoint()`).
export async function holdAttachments(
  fetchEndpoint: FetchEndpoint,
  holder: string,
  ids: readonly string[],
  ttlMs: number | null,
): Promise<void> {
  await fetchEndpoint(
    holdAttachmentsEndpoint,
    {},
    { body: { holder, ids: [...ids], ttlMs } },
  );
}
