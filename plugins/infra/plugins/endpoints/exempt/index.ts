import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "Primitives that legitimately wrap fetch(). These ARE the sanctioned low-level transport the rest of the app is forbidden from reaching for directly.",
  },
  {
    rule: "networking/no-request-guard-capability",
    paths: ["web/internal/asset-url.ts", "web/internal/asset-src.ts"],
    kind: "sanctioned",
    reason:
      "assetUrlOver and useAssetSrc are the places an asset URL is handed out — to a sink that loads by URL on its own, or to an element whose src anything re-fetching the page's images (a screenshot inlining every <img>) loads again from the page realm; each registers that URL's route with the request guard (allowAssetRoute) so the GET / HEAD passes.",
  },
] satisfies Exemptions;
