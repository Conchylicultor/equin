import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  SectionCount,
  PluginLink,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import type {
  RoutesData,
  RouteDef,
} from "@plugins/plugin-meta/plugins/facets/plugins/routes/core";

// Renders the routes facet's own data. Read `node.facets[id]` directly (as every
// render host does) rather than importing the build-time `facets/core` barrel,
// which would drag `loadFacets` + `fs`/`path` into the browser bundle. The
// type-only import from the facet core is erased and safe.
const ROUTES_FACET_ID = "routes";

// Ported from public-api-section.tsx's RoutesGroup. The facet stores the method
// inside the route string for HTTP routes ("GET /api/foo") and carries
// type === "ws" for WS routes, which have no method prefix.
const METHOD_COLORS: Record<string, string> = {
  GET: "text-categorical-2",
  POST: "text-categorical-1",
  PUT: "text-categorical-3",
  PATCH: "text-categorical-3",
  DELETE: "text-categorical-4",
  WS: "text-categorical-5",
};

function methodAndPath(r: RouteDef): { method: string; path: string } {
  if (r.type === "ws") return { method: "WS", path: r.route };
  const spaceIdx = r.route.indexOf(" ");
  if (spaceIdx < 0) return { method: "", path: r.route };
  return {
    method: r.route.slice(0, spaceIdx),
    path: r.route.slice(spaceIdx + 1),
  };
}

/** The plugin's routes + endpoint callers, or `null` when it has neither. */
function routes(node: PluginNode): RoutesData | null {
  const data = node.facets?.[ROUTES_FACET_ID] as RoutesData | undefined;
  if (!data) return null;
  if (data.routes.length === 0 && data.endpointCallers.length === 0)
    return null;
  return data;
}

/** No routes and no callers ⇒ the host paints no card at all. */
export function useRoutesAvailable({ node }: { node: PluginNode }): boolean {
  return routes(node) !== null;
}

export function RoutesCount({ node }: { node: PluginNode }) {
  const data = routes(node);
  if (!data) return null;
  const parts: string[] = [];
  if (data.routes.length > 0)
    parts.push(
      `${data.routes.length} route${data.routes.length !== 1 ? "s" : ""}`,
    );
  if (data.endpointCallers.length > 0)
    parts.push(
      `${data.endpointCallers.length} caller${data.endpointCallers.length !== 1 ? "s" : ""}`,
    );
  return <SectionCount>{parts.join(" · ")}</SectionCount>;
}

export function RoutesDetailSection({ node }: { node: PluginNode }) {
  const data = routes(node);
  if (!data) return null;

  const { routes: routeDefs, endpointCallers } = data;

  return (
    <Stack gap="md">
      {endpointCallers.length > 0 && <CallersBanner names={endpointCallers} />}
      {routeDefs.length > 0 && (
        <Stack gap="2xs">
          {routeDefs.map((r) => {
            const { method, path } = methodAndPath(r);
            return (
              <Text
                as={Line}
                variant="caption"
                key={`${r.runtime}:${r.type}:${r.route}`}
                className="gap-sm px-sm py-2xs"
              >
                {method && (
                  <span
                    className={cn(
                      rigidClass(),
                      "w-10 font-mono text-3xs font-semibold",
                      METHOD_COLORS[method] ?? "text-muted-foreground",
                    )}
                  >
                    {method}
                  </span>
                )}
                <Fill as="code" className="truncate font-mono text-foreground">
                  {path}
                </Fill>
                <span
                  className={cn(
                    rigidClass(),
                    "text-3xs text-muted-foreground/50",
                  )}
                >
                  {r.runtime}
                </span>
              </Text>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

// ── Endpoint-callers banner (mirrors cross-refs' ImportedByBanner) ───

function CallersBanner({ names }: { names: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const threshold = 4;
  const visible = expanded ? names : names.slice(0, threshold);
  const remaining = names.length - threshold;

  return (
    <Cluster gap="xs" className="gap-y-2xs text-3xs text-muted-foreground">
      <span className="font-medium">Endpoint callers</span>
      {visible.map((name, i) => (
        <Inline gap="none" key={name}>
          <PluginLink name={name} />
          {i < visible.length - 1 && (
            <span className="text-muted-foreground/40">,</span>
          )}
        </Inline>
      ))}
      {!expanded && remaining > 0 && (
        <button
          className="text-muted-foreground/60 hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          +{remaining} more
        </button>
      )}
    </Cluster>
  );
}
