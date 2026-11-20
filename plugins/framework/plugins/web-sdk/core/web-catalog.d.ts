// The page's list catalog module, `@composition-web-catalog`: the build
// writes it per composition (web-artifacts' `page-catalog.ts`, the registry
// artifact's `catalog.js`) — the list catalog kept to the plugins the deployed
// composition loads. No source file holds it; this declares its shape for the
// type checker (`tsconfig.base.json` maps the specifier here).
import type { WebCatalog } from "@plugins/framework/plugins/list-catalog/core";

export declare const webCatalog: WebCatalog;
