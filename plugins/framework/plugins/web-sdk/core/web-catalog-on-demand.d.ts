// The page's list catalog WITH its composition's on-demand plugins,
// `@composition-web-catalog-on-demand`: written by the build per composition
// (web-artifacts' `page-catalog.ts`, the registry artifact's
// `catalog-on-demand.js`), loaded by App.tsx with those plugins. No source
// file holds it; this declares its shape for the type checker.
import type { WebCatalog } from "@plugins/framework/plugins/list-catalog/core";

export declare const webCatalog: WebCatalog;
