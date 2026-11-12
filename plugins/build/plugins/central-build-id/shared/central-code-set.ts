/**
 * Central's code as the source set `sourceDigest` reads (structurally: a
 * description and the entry's URL) — ONE spelling for both sides that digest
 * it, central over the entry it runs and `./equin build` over the checkout's
 * `CENTRAL_ENTRY`, so the two digests can only differ when the code does.
 */
export function centralCodeSet(entryUrl: string): {
  description: string;
  urls: () => readonly string[];
} {
  return {
    description: "central's code (its entry closure)",
    urls: () => [entryUrl],
  };
}
