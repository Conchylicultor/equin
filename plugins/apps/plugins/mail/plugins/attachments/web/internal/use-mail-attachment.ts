import { useCallback } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  transportScoped,
  useTransport,
} from "@plugins/primitives/plugins/networking/web";
import { mailAttachmentDownloadEndpoint } from "../../core";

// A stored attachment id is minted once and never changes, so the resolved blob
// URL is immutable. This cache dedupes every download of the same row forever —
// across message cards, re-mounts, and repeated `cid:` resolutions within one
// page — collapsing N concurrent requests to one in-flight promise. One cache
// per transport: the URL is the answering host's, so another host's is not it.
const downloadCaches = transportScoped(
  () => new Map<string, Promise<string>>(),
);

export interface UseMailAttachment {
  /**
   * Ensure the attachment's bytes are downloaded + cached, resolving to its
   * same-origin URL. Deduped per row: repeated calls share one request. A
   * failure clears the cache entry so a later call can retry.
   */
  download: (attachmentRowId: string) => Promise<string>;
}

export function useMailAttachment(): UseMailAttachment {
  const fetchEndpoint = useFetchEndpoint();
  const transport = useTransport();
  const download = useCallback(
    (attachmentRowId: string): Promise<string> => {
      const downloadCache = downloadCaches.of(transport);
      const cached = downloadCache.get(attachmentRowId);
      if (cached) return cached;

      const promise = fetchEndpoint(
        mailAttachmentDownloadEndpoint,
        {},
        { body: { attachmentRowId } },
      )
        .then((res) => res.url)
        .catch((err: unknown) => {
          // Drop the failed promise so a retry re-fetches instead of re-throwing
          // the cached rejection forever. Re-throw so the caller still sees it.
          downloadCache.delete(attachmentRowId);
          throw err;
        });

      downloadCache.set(attachmentRowId, promise);
      return promise;
    },
    [fetchEndpoint, transport],
  );

  return { download };
}
