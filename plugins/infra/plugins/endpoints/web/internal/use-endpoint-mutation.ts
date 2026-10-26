import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import type {
  EndpointDef,
  MachineEndpointDef,
  MachineResult,
  MachineUnavailable,
} from "../../core";
import { unavailableMessage } from "../../core";
import { EndpointError } from "../../core";
import { useFetchEndpoint } from "./fetch-endpoint";

// The global mutation meta type (`suppressError`) is react-query's `Register`,
// augmented in `./react-query-register.d.ts`.

type MutationVariables<TParams, TBody> =
  TParams extends Record<string, never>
    ? TBody extends void
      ? { params?: TParams; body?: never }
      : { params?: TParams; body: TBody }
    : TBody extends void
      ? { params: TParams; body?: never }
      : { params: TParams; body: TBody };

type MutationOptions<TResponse> = {
  onSuccess?: (data: TResponse extends void ? void : TResponse) => void;
  onError?: (err: EndpointError) => void;
  // Explicit override for the global toast. Defaults to true when onError is provided.
  meta?: { suppressError?: boolean };
};

type EndpointMutation<TParams, TBody, TResponse> = UseMutationResult<
  TResponse extends void ? void : TResponse,
  EndpointError,
  MutationVariables<TParams, TBody>
>;

/**
 * A desktop-only endpoint's mutation, decided at the HOOK level: `unavailable`
 * (with the sentence to show) under a transport with no computer behind it,
 * else the mutation — so a call site cannot reach `mutate` without narrowing.
 * A subtree's transport is fixed, so the arm is stable across renders.
 */
export type MachineEndpointMutation<TParams, TBody, TResponse> =
  | MachineUnavailable
  | ({ kind: "available" } & EndpointMutation<TParams, TBody, TResponse>);

/**
 * TanStack Query useMutation wrapper for POST/PATCH/DELETE endpoints.
 *
 * It refreshes no read: every server read is live (`network/live`), pushed
 * when the write lands, so there is nothing to invalidate by hand.
 * On error, the global auto-toast fires unless onError is provided or meta.suppressError is set.
 *
 * A desktop-only endpoint (`needsMachine`) answers a {@link MachineEndpointMutation}.
 */
export function useEndpointMutation<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  opts?: MutationOptions<TResponse>,
): MachineEndpointMutation<TParams, TBody, TResponse>;
export function useEndpointMutation<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint: EndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  opts?: MutationOptions<TResponse>,
): EndpointMutation<TParams, TBody, TResponse>;
export function useEndpointMutation<
  Route extends string,
  TParams,
  TBody,
  TResponse,
  TQuery,
>(
  endpoint:
    | EndpointDef<Route, TParams, TBody, TResponse, TQuery>
    | MachineEndpointDef<Route, TParams, TBody, TResponse, TQuery>,
  opts?: MutationOptions<TResponse>,
):
  | EndpointMutation<TParams, TBody, TResponse>
  | MachineEndpointMutation<TParams, TBody, TResponse> {
  const transport = useTransport();
  const fetchEndpoint = useFetchEndpoint();
  const suppressError =
    opts?.meta?.suppressError ?? opts?.onError !== undefined;

  const mutation = useMutation<
    TResponse extends void ? void : TResponse,
    EndpointError,
    MutationVariables<TParams, TBody>
  >({
    meta: { suppressError },
    mutationFn: async (variables) => {
      const params = (variables.params ?? {}) as TParams;
      const body = "body" in variables ? variables.body : undefined;
      const fetchOpts = body !== undefined ? { body } : {};
      if (endpoint.needsMachine === undefined) {
        return fetchEndpoint(
          endpoint,
          params,
          // internal dispatch; external callers are fully typed
          fetchOpts as any,
        ) as Promise<TResponse extends void ? void : TResponse>;
      }
      const result = (await fetchEndpoint(
        endpoint,
        params,
        // internal dispatch; external callers are fully typed
        fetchOpts as any,
      )) as MachineResult<TResponse extends void ? void : TResponse>;
      // Unreachable: the hook hands out `mutate` only under a transport with
      // the computer behind it, and a subtree's transport is fixed.
      if (result.kind === "unavailable") throw new Error(result.message);
      return result.value;
    },
    onSuccess: opts?.onSuccess,
    onError: opts?.onError,
  });
  if (endpoint.needsMachine === undefined) return mutation;
  return transport.machine
    ? { kind: "available", ...mutation }
    : {
        kind: "unavailable",
        message: unavailableMessage(endpoint.needsMachine),
      };
}
