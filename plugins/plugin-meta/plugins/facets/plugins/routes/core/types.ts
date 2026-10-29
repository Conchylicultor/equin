import type { RoutePrediction } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";

export interface RouteDef {
  route: string;
  type: "http" | "ws";
  runtime: "server" | "machine" | "central";
  name?: string;
  /** How a write route decides its effect reaches the user; absent for a read and for a literal/WS route. */
  prediction?: RoutePrediction;
}

export interface RoutesData {
  routes: RouteDef[];
  endpointCallers: string[];
  /** Transient: every `/api/<prefix>` this plugin's own web/server/central
   *  source names, recorded by extract() (which has no tree). relate() joins
   *  these against the owners' routes and clears the field. */
  apiPrefixesUsed?: string[];
}

export const routesFacetDef = defineFacet<RoutesData>("routes");
