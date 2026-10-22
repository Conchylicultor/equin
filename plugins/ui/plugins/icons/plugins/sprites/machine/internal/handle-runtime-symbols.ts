import { isStyleKey, type StyleKey } from "@plugins/ui/plugins/icons/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { runtimeSymbols, symbolsHash } from "./runtime-symbols";

/** At most this many names per request: a URL stays well under any proxy's limit. */
export const MAX_RUNTIME_SYMBOLS_PER_REQUEST = 200;

/**
 * `GET /api/icons/symbols/:hash/:key?names=a,b,c` — saved (runtime) symbols in
 * one style as `image/svg+xml`, for `<Icon>` on a name the resident saved-icon
 * sprites do not carry in that style (a picker grid, a history preview, a
 * themed scope).
 *
 * Content-addressed: `names` must be sorted and duplicate-free (400 otherwise —
 * two spellings of one request would defeat the cache), `hash` must be this
 * process's sets hash (409 otherwise), and an unknown name is a 404. So the
 * response is immutable for its URL.
 *
 * A raw handler for the immutable cache header, like the sprite route.
 */
export async function handleRuntimeSymbols(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const key = params.key;
  if (key === undefined || !isStyleKey(key)) {
    return new Response(`unknown style key: ${key}`, { status: 404 });
  }
  if (params.hash !== symbolsHash) {
    return new Response(
      `symbols version ${params.hash} is not this server's (${symbolsHash}); reload the page`,
      { status: 409 },
    );
  }
  const raw = new URL(req.url).searchParams.get("names");
  if (raw === null || raw === "") {
    return new Response("names is required", { status: 400 });
  }
  const names = raw.split(",");
  if (names.length > MAX_RUNTIME_SYMBOLS_PER_REQUEST) {
    return new Response(
      `at most ${MAX_RUNTIME_SYMBOLS_PER_REQUEST} names per request`,
      { status: 400 },
    );
  }
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1]! >= names[i]!) {
      return new Response("names must be sorted and duplicate-free", {
        status: 400,
      });
    }
  }
  const unknown = names.filter((n) => !isSavedSymbolName(n));
  if (unknown.length > 0) {
    return new Response(`unknown symbol name(s): ${unknown.join(", ")}`, {
      status: 404,
    });
  }
  return new Response(await runtimeSymbols(key as StyleKey, names), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
