import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { setKeyAutoDetectEndpoint } from "../shared/endpoints";

// Fire-and-forget write: the UI never reads the response — state refreshes via
// the `keyAutoDetects` row push the upsert's commit triggers. `void` keeps
// the no-floating-promises rule satisfied while a genuine network failure still
// surfaces loudly as an unhandled rejection (reported by the crashes plugin).
// Named `save*` (not `set*`) to stay distinct from the in-memory write of the
// loaded song's setting (`useWriteSongSetting(keyAutoDetectSetting)`), which a
// toggle handler makes optimistically alongside this persistence call.
export function saveKeyAutoDetect(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  enabled: boolean,
): void {
  void fetchEndpoint(
    setKeyAutoDetectEndpoint,
    { id: songId },
    { body: { enabled } },
  );
}
