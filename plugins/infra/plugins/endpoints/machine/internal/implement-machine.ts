import type {
  HttpHandler,
  MachineEndpointHttpHandler,
} from "@plugins/framework/plugins/server-core/core";
import type {
  InternalMachineEndpointDef,
  MachineEndpointDef,
  PredictedMachineEndpointDef,
} from "../../core/define-endpoint";
import type { AgentWrite } from "../../core/agent-write";
import type { EndpointAccess } from "@plugins/framework/plugins/principal/core";
import {
  endpointHandler,
  rawEndpointHandler,
  type EndpointHandler,
} from "../../core/implement";

/**
 * The server handler for a desktop-only endpoint (`needsMachine`): the same
 * request handling as `implement`, branded `MachineHttpHandler` — the only
 * handler a `machine/` barrel's `httpRoutes` accepts, and one no `server/`
 * barrel's accepts. A portable endpoint is a tsc error here, so machine code
 * alone can never serve one (a silent 404 on every host without the computer).
 */
export function implementMachine<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint:
    | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>
    // The server ignores a predicted effect: it is the browser's.
    | PredictedMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>
    // No browser calls it; the machine half serves it like any other.
    | InternalMachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  handler: EndpointHandler<TParams, TBody, TResponse, TQuery>,
): MachineEndpointHttpHandler {
  // The brand is type-only: a machine handler IS a handler.
  return endpointHandler(endpoint, handler) as MachineEndpointHttpHandler;
}

/**
 * A RAW handler (`(req, params) => Response`) a `machine/` barrel serves: for a
 * route with no typed contract — a binary or streamed answer, a harness that
 * returns its own status — whose code needs the computer. Brands it
 * `MachineHttpHandler`, the only handler a machine barrel's `httpRoutes` take.
 * A route a client calls through a typed endpoint is `implementMachine`'s, so
 * its callers get the unavailable arm; this one has no client contract to give.
 *
 * It still takes the route's declaration (`route`, `method`, `agentWrite`,
 * `access`): a write route runs the agent-write gate first
 * (`rawEndpointHandler`), so a raw machine write is refused to an agent session
 * on main like any other, and the route's access rides on the handler.
 */
export function machineHandler(
  endpoint: {
    route: string;
    method: string;
    agentWrite?: AgentWrite;
    access?: EndpointAccess;
  },
  handler: HttpHandler,
): MachineEndpointHttpHandler {
  // The brand is type-only: a machine handler IS a handler.
  return rawEndpointHandler(endpoint, handler) as MachineEndpointHttpHandler;
}
