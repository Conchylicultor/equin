import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { holdAttachmentsEndpoint } from "../../shared/endpoints";

// Keep exactly `ids` alive on behalf of `holder` (an unsent draft the server
// cannot see) for `ttlMs` from now — `null` until released. Replaces the
// holder's previous set; an empty `ids` releases it.
export async function holdAttachments(
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
