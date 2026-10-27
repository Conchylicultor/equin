import { serveValue } from "@plugins/network/plugins/live/server";
import { UgFetchError } from "../../core";
import { ugTab } from "../../shared/resources";
import { fetchUgTabContent } from "./ug-client";

/**
 * The raw tab a UG tab URL names. A classified `UgFetchError` about the URL
 * itself (not a tab URL, no such tab) is a declared refusal; every other kind
 * (signature rejected, a changed shape, the network) propagates as a loader
 * failure — loud, a crash-worthy upstream breakage.
 */
export const ugTabServed = serveValue(ugTab, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer to one URL (UG's mobile API): no change signal",
    },
  },
  loader: async ({ url }) => {
    // One tuple per question: an untrimmed URL is refused, not trimmed here,
    // so `"u "` and `"u"` cannot be two cached answers to one fetch.
    if (url !== url.trim()) {
      throw ugTab.refuse("invalid-url", "A UG tab URL must be trimmed.");
    }
    try {
      return await fetchUgTabContent(url);
    } catch (err) {
      if (err instanceof UgFetchError) {
        switch (err.kind) {
          case "invalid-url":
          case "not-found":
            throw ugTab.refuse(err.kind, err.message);
          case "signature-rejected":
          case "bad-request":
          case "upstream":
          case "malformed-response":
          case "network":
            throw err;
        }
      }
      throw err;
    }
  },
});
