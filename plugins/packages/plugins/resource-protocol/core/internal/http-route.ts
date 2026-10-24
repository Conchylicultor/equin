/**
 * The live-state HTTP read route every host mounts its resource runtime's
 * `handleResourceHttp` at: the one-shot fallback read of a resource by key.
 */
export const RESOURCE_HTTP_ROUTE = "GET /api/resources/:key";

/**
 * Central's twin of {@link RESOURCE_HTTP_ROUTE}: the HTTP read central-core's
 * boot mounts for its own runtime (a core-owned route, held by no barrel's
 * `httpRoutes`) — where the live-state client sends an `origin: "central"`
 * read.
 */
export const CENTRAL_RESOURCE_HTTP_ROUTE = "GET /api/central-resources/:key";
