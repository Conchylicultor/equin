import { db, quotedRelationsIn } from "@plugins/database/server";
import { ResourceContractError } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import {
  defineDeferredResource,
  defineResource,
} from "@plugins/framework/plugins/server-core/core";
import type { Resource } from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import type {
  PointParams,
  WindowParams,
  WindowSelector,
} from "@plugins/network/plugins/live/plugins/live-state/core";
import type {
  AllJoinSpec,
  AllQueryParams,
  PointQueryResourceContract,
  WindowQueryResourceContract,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import {
  compileAllCollectionWith,
  type AllCollectionContracts,
  type AllCollectionSpec,
  type CompiledAllCollection,
} from "./compile-alias";
import {
  assertKeyField,
  compileOffFeedQueryWith,
  compileWindowQueryWith,
  type AnyWindowContract,
  type CompiledOffFeedQuery,
  type CompiledWindowQuery,
} from "./compile-window";
import type { FollowablePlan } from "./follow";
import type {
  BoundedQueryResourceSpec,
  CompileHost,
  PointQueryResourceSpec,
  QueryDb,
  RoutedSource,
  WindowQueryResourceSpec,
} from "./spec";

// The registration half of the compiled collection reads: the real database
// and server-core's resource registry, handed to the compilers. Deliberately
// OUTSIDE the `liveReadCode` source set (`compile-window.ts` and
// `compile-alias.ts` include themselves, with everything they load): what
// registers a resource and which pool runs its SQL shape no row, and the
// database and server-core barrels load a few hundred modules (boot hooks,
// migrations, endpoints) whose every edit used to move the digest — the epoch
// handoff then inherited nothing and every point read reloaded at the
// restart. Never import this module from a digested one; a compile reads the
// database through its `CompileHost`.

// One boundary cast (the entities plugin precedent): the real drizzle `db` as
// the minimal `QueryDb` the compilers read. Safe at module eval — the pool is
// built lazily on the first query.
const realHost: CompileHost = {
  db: db as unknown as QueryDb,
  quotedRelationsIn,
  contractError: (key, detail) => new ResourceContractError(key, detail),
};

/**
 * Turn a bounded spec + its shared contract into the two-arg `defineResource`
 * server half, without registering — the real database unless the spec
 * carries its own `db` (a test's fake).
 */
export function compileWindowQuery<Row, P extends WindowParams | PointParams>(
  contract: AnyWindowContract<Row, P & WindowParams>,
  spec: BoundedQueryResourceSpec<P>,
): CompiledWindowQuery<Row, P> {
  return compileWindowQueryWith(realHost, contract, spec);
}

/** `compileWindowQuery` OFF the change feed (see `CompiledOffFeedQuery`). */
export function compileOffFeedQuery<Row, P extends WindowParams | PointParams>(
  contract: AnyWindowContract<Row, P & WindowParams>,
  spec: BoundedQueryResourceSpec<P>,
): CompiledOffFeedQuery<Row, P> {
  return compileOffFeedQueryWith(realHost, contract, spec);
}

/** Compile a collection declared `all` (`./compile-alias`) over the real database. */
export function compileAllCollection<
  Row,
  T extends RoutedSource,
  const J extends readonly AllJoinSpec[] = readonly [],
  B extends string = never,
>(
  contracts: AllCollectionContracts<Row, B>,
  spec: AllCollectionSpec<T, J>,
): CompiledAllCollection<Row, AllQueryParams<B>> {
  return compileAllCollectionWith(realHost, contracts, spec);
}

/**
 * `windowQueryResource` whose spec is only known at boot, once contributions
 * are collected (a collection whose columns other plugins contribute): the
 * resource registers now under its descriptor, and `specOf` compiles at
 * `bindDeferredResources` — through the same compiler and the same checks.
 */
export function deferredWindowQueryResource<
  Row,
  P extends WindowParams = WindowParams,
  S extends WindowSelector = WindowSelector,
>(
  descriptor: WindowQueryResourceContract<Row, P, S>,
  specOf: () => WindowQueryResourceSpec<P>,
): Resource<Row[], P>;
export function deferredWindowQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  specOf: () => PointQueryResourceSpec<PointParams>,
): Resource<Row[], PointParams>;
export function deferredWindowQueryResource<Row>(
  descriptor: AnyWindowContract<Row>,
  specOf: () =>
    WindowQueryResourceSpec<WindowParams> | PointQueryResourceSpec<PointParams>,
): Resource<Row[], WindowParams> | Resource<Row[], PointParams> {
  return defineDeferredResource(descriptor, () => {
    const { serverOpts, keyField } = compileWindowQuery(
      descriptor,
      specOf() as BoundedQueryResourceSpec<WindowParams | PointParams>,
    );
    assertKeyField(descriptor as AnyWindowContract<unknown>, keyField);
    return serverOpts;
  });
}

/**
 * A `:rows` point set registered with what a follow copies of it (`./follow`):
 * the resource, and its followable — at once for an eager compile, or a
 * getter that throws until `bindDeferredResources` compiled a deferred one.
 */
export interface FollowablePoint<Row> {
  resource: Resource<Row[], PointParams>;
  followable: () => FollowablePlan;
}

/** `windowQueryResource` for a point set, with its followable (see `FollowablePoint`). */
export function pointQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  spec: PointQueryResourceSpec<PointParams>,
): FollowablePoint<Row> {
  const compiled = compileWindowQuery(
    descriptor as AnyWindowContract<Row, PointParams & WindowParams>,
    spec as BoundedQueryResourceSpec<PointParams>,
  );
  assertKeyField(descriptor as AnyWindowContract<unknown>, compiled.keyField);
  const followable = pointFollowable(descriptor.key, compiled);
  return {
    resource: defineResource(descriptor, compiled.serverOpts),
    followable: () => followable,
  };
}

/** `deferredWindowQueryResource` for a point set, with its followable (see `FollowablePoint`). */
export function deferredPointQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  specOf: () => PointQueryResourceSpec<PointParams>,
): FollowablePoint<Row> {
  let followable: FollowablePlan | undefined;
  const resource = defineDeferredResource(descriptor, () => {
    const compiled = compileWindowQuery(
      descriptor as AnyWindowContract<Row, PointParams & WindowParams>,
      specOf() as BoundedQueryResourceSpec<PointParams>,
    );
    assertKeyField(descriptor as AnyWindowContract<unknown>, compiled.keyField);
    followable = pointFollowable(descriptor.key, compiled);
    return compiled.serverOpts;
  });
  return {
    resource,
    followable: () => {
      if (followable === undefined) {
        throw new Error(
          `pointQueryResource("${descriptor.key}"): followed before bindDeferredResources compiled it — a follower of a deferred collection binds after it.`,
        );
      }
      return followable;
    },
  };
}

function pointFollowable(
  key: string,
  compiled: CompiledWindowQuery<unknown, PointParams>,
): FollowablePlan {
  if (compiled.followable === null) {
    // Unreachable: a point descriptor compiles to the point arm.
    throw new Error(`pointQueryResource("${key}"): compiled no point set.`);
  }
  return compiled.followable;
}

/**
 * Compile a bounded spec and register the keyed resource against the shared
 * contract. Asserts the contract's `queryPk` equals the derived keyField — a
 * LOUD throw at module evaluation (boot crash) on drift. (A whole ordered set
 * is not a bounded spec: declare it `liveCollection(key, { all })`.)
 */
export function windowQueryResource<
  Row,
  P extends WindowParams = WindowParams,
  S extends WindowSelector = WindowSelector,
>(
  descriptor: WindowQueryResourceContract<Row, P, S>,
  spec: WindowQueryResourceSpec<P>,
): Resource<Row[], P>;
export function windowQueryResource<Row>(
  descriptor: PointQueryResourceContract<Row>,
  spec: PointQueryResourceSpec<PointParams>,
): Resource<Row[], PointParams>;
export function windowQueryResource<Row>(
  descriptor: AnyWindowContract<Row>,
  spec:
    WindowQueryResourceSpec<WindowParams> | PointQueryResourceSpec<PointParams>,
): Resource<Row[], WindowParams> | Resource<Row[], PointParams> {
  const { serverOpts, keyField } = compileWindowQuery(
    descriptor,
    spec as BoundedQueryResourceSpec<WindowParams | PointParams>,
  );
  assertKeyField(descriptor as AnyWindowContract<unknown>, keyField);
  return defineResource(descriptor, serverOpts);
}
