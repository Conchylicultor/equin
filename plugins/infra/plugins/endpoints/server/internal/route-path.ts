import type { AnyEndpointDef } from "../../core";

/**
 * Interpolate params into a path template.
 * interpolatePath("/api/agents/:id", { id: "abc" }) → "/api/agents/abc"
 *
 * The server barrel's own copy of core's (`core/route-params.ts`): the core
 * barrel exports no route-to-string builder — on a page a route's string is a
 * leak — and the server barrel, which the browser host's worker loads too, can
 * reach `core/` only through that barrel. `route-path.test.ts` holds the two to
 * the same answer.
 */
export function interpolatePath(
  template: string,
  params: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, encodeURIComponent(value));
  }
  return result;
}

/**
 * An endpoint's path, built from its contract: the route's params interpolated
 * (typed by the route) and the query appended (an absent or nullish member
 * dropped). For a URL handed to someone else rather than fetched here — an
 * agent's MCP URL, a `<link>` in served HTML, a command another machine runs —
 * so it cannot drift from the route either. Off the page only: what a page
 * loads is an `AssetPath`.
 */
export function endpointPath<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: AnyEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  params: TParams,
  query?: TQuery,
): string {
  const route: string = endpoint.route;
  let path = interpolatePath(
    route.slice(route.indexOf(" ") + 1),
    (params ?? {}) as Record<string, string>,
  );
  if (query != null) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(
      query as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) path += `?${qs}`;
  }
  return path;
}
