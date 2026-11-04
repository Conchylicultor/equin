/**
 * Installs the page request guard (`primitives/networking/plugins/request-guard`)
 * — imported FIRST by `main.tsx`, as a side effect, so it runs before the rest
 * of the entry's static import graph (`App` and every plugin it pulls in)
 * evaluates. A call in `main.tsx`'s own body would run after all of it.
 *
 * Every asset route a sink loads by URL is registered as `assetUrlOver` /
 * `assetFetchOver` hands it out.
 */
import { installRequestGuard } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";

installRequestGuard();
