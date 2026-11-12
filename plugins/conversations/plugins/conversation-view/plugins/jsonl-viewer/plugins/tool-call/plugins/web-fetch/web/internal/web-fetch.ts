import { z } from "zod";

/** WebFetch's input, as its card draws it. */
export const WebFetchInputSchema = z.looseObject({
  url: z.string(),
  prompt: z.string(),
  offset: z.number().optional(),
});

/** What the card draws while the model is still writing the call: any field may be missing yet. */
export const PartialWebFetchInputSchema = WebFetchInputSchema.partial();
export type PartialWebFetchInput = z.infer<typeof PartialWebFetchInputSchema>;

/** `host/path`, scheme, `www.` and a bare trailing slash dropped. A cut URL
 *  that does not parse yet is shown as written. */
export function compactUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const u = new URL(url);
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`;
}
