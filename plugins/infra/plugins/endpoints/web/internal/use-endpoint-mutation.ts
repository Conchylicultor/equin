import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import type {
  EndpointDef,
  MachineEndpointDef,
  MachineResult,
  MachineUnavailable,
} from "../../core";
import { unavailableMessage } from "../../core";
import { EndpointError, fetchEndpoint } from "./fetch-endpoint";

// Global mutation meta type — available on any useMutation/useEndpointMutation call.
// suppressError: true  → silence the global auto-toast (handle locally instead).
// When onError is provided, suppressError defaults to true automatically.
declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      suppressError?: boolean;
    };
  }
}

type MutationVariables<TParams, TBody> =
  TParams extends Record<string, never>
    ? TBody extends void
      ? { params?: TParams; body?: never }
      : { params?: TParams; body: TBody }
    : TBody extends void
      ? { params: TParams; body?: never }
      : { params: TParams; body: TBody };

type MutationOptions<TResponse> = {
  // invalidation targets are heterogeneous
  invalidates?: (
    | EndpointDef<any, any, any, any, any>
    | MachineEndpointDef<any, any, any, any, any>
  )[];
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
 * On success, invalidates queries matching the listed endpoints' query key prefixes.
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
  const queryClient = useQueryClient();
  const transport = useTransport();
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
      const fetchOpts =
        body !== undefined ? { body, transport } : { transport };
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
    onSuccess: (data) => {
      if (opts?.invalidates) {
        for (const dep of opts.invalidates) {
          void queryClient.invalidateQueries({
            queryKey: ["endpoint", dep.route],
          });
        }
      }
      opts?.onSuccess?.(data);
    },
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
