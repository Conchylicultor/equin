import { z } from "zod";

/**
 * The served dist's per-app preload list, beside its `index.html`: written by
 * the web-artifacts compose step, read by this plugin's machine half to put
 * the active app's code in the page's head.
 */
export const APP_PRELOADS_FILE = ".app-preloads.json";

/**
 * Per app root (`apps/plugins/<app>/`, {@link appRootOf}): the module URLs the
 * app's deferred plugins load — their static import closure, dependencies
 * first, minus what the shell already preloads for every page.
 */
export const AppPreloadsSchema = z.object({
  v: z.literal(1),
  apps: z.record(z.string(), z.array(z.string())),
});
export type AppPreloads = z.infer<typeof AppPreloadsSchema>;
