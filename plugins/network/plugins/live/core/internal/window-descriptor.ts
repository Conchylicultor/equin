import { z } from "zod";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  registerResourceDescriptor,
  type PointParams,
  type ResourceDescriptor,
  type ResourcePreload,
  type WindowParams,
  type WindowSelector,
} from "@plugins/primitives/plugins/live-state/core";
import type {
  AllQueryResourceContract,
  PointQueryResourceContract,
  WindowQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";

// The factories `liveCollection` mints its resources with: the window
// (`windowQueryResourceDescriptor`), the `:rows` point sibling
// (`pointQueryResourceDescriptor`) and the whole ordered set of a collection
// declared `all` (`allResourceDescriptor`). Internal to this plugin on purpose — the
// barrel exports `liveCollection`, and a collection is the one way to declare a
// bounded resource. A second, lower-level spelling would be a way to mint a
// window or point resource without the row schema, id and filterable columns
// `serveCollection` binds to the table.
//
// Each returns a query-resource CONTRACT (`{Window,Point,All}QueryResourceContract`,
// declared in `query-resource/core`): the live-state descriptor (which carries
// the selector codec both sides share) plus `queryPk`, so the server's
// `windowQueryResource` — the compiler behind `serveCollection` — can assert the
// descriptor and the derived query identity key on the same field (a boot-time
// throw on drift, not a runtime mismatch). The types stay in `query-resource`
// because its server consumes them, and `query-resource` never imports
// `network/live`.
//
// The selector codecs follow the bounded working-set contract
// (research/2026-07-18-global-bounded-working-set-resource-contract.md). A
// window/point subscription is just a params tuple, so the SAME logical
// selector MUST always produce the SAME params object: paramsKey identity is
// what makes boot hydration, the client subscription (`useLive`), and the
// server loader land on ONE per-tuple state. Both codecs are therefore canonical on
// encode and STRICT on decode (malformed params throw — fail loudly; a
// defaulting decode would let `{}` and the default window name the same
// logical window under two paramsKeys, doubling every per-tuple state).
// `liveCollection` replaces the window's limit-only codec with its query codec,
// which holds the same two properties.
//
// A window or id set not loaded yet is `pending`, never `[]`, exactly like a
// `liveValue`.
//
// A failed DECODE throws `ResourceContractError` (a subscription's params do
// not match the declaration — the runtime refuses it as `contract-mismatch`); a
// failed declaration or encode stays a plain `Error`, a programmer error.

function assertWindowLimit(limit: number, context: string): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(
      `${context}: window limit must be a positive integer, got ${limit}`,
    );
  }
}

function pkKeyOf<Row>(pkField: keyof Row & string): (row: unknown) => string {
  return (row) => String((row as Record<string, unknown>)[pkField]);
}

/** A keyed row-array descriptor, registered for boot hydration. */
function keyedRows<Row, P extends Record<string, string>>(
  key: string,
  rowSchema: ZodParser<Row>,
  pkField: keyof Row & string,
  opts: {
    preload?: ResourcePreload;
    /** The params gate — see `ResourceDescriptor.validateParams`. */
    validateParams: (params: Record<string, string>) => void;
  },
): ResourceDescriptor<Row[], P> & {
  keyed: { keyOf: (row: unknown) => string };
} {
  const d = {
    key,
    schema: z.array(rowSchema),
    keyed: { keyOf: pkKeyOf(pkField) },
    ...opts,
  };
  registerResourceDescriptor(d as ResourceDescriptor<unknown>);
  return d;
}

/**
 * Declare a bounded ordered-window keyed resource whose rows are a flat SQL
 * query result. A keyed row-array descriptor (schema `z.array(rowSchema)`, so a
 * reader still gets `Row[]` and the keyed delta wire is unchanged) plus the
 * window codec + the canonical `defaultParams`
 * tuple, and records `queryPk` for the server-side drift assertion. The
 * matching server half is `windowQueryResource(descriptor, spec)`, which
 * `serveCollection` calls.
 */
export function windowQueryResourceDescriptor<Row>(
  key: string,
  rowSchema: ZodParser<Row>,
  pkField: keyof Row & string,
  opts: { defaultLimit: number; preload?: ResourcePreload },
): WindowQueryResourceContract<Row> {
  const { defaultLimit, ...rest } = opts;
  assertWindowLimit(defaultLimit, `windowQueryResourceDescriptor("${key}")`);

  const encode = (sel?: WindowSelector): WindowParams => {
    const limit = sel?.limit ?? defaultLimit;
    assertWindowLimit(limit, `windowQueryResourceDescriptor("${key}").encode`);
    return { limit: String(limit) };
  };
  const decode = (params: Record<string, string>): { limit: number } => {
    const raw = params.limit;
    if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
      throw new ResourceContractError(
        key,
        `windowQueryResourceDescriptor("${key}").decode: params.limit must be a ` +
          `canonical positive-integer string, got ${JSON.stringify(raw)}`,
      );
    }
    return { limit: Number(raw) };
  };

  const d = keyedRows<Row, WindowParams>(key, rowSchema, pkField, {
    ...rest,
    validateParams: (params: Record<string, string>) => void decode(params),
  });
  return Object.assign(d, {
    defaultParams: encode(),
    window: { defaultLimit, encode, decode },
    queryPk: pkField,
  });
}

/**
 * Declare an explicit point-set keyed resource whose rows are a flat SQL query
 * result — the `windowQueryResourceDescriptor` twin for `point: { by }` specs,
 * and a collection's `:rows` sibling. The id-set codec lives on the descriptor
 * so the client reads and the server compiler share one encoding; `decode`
 * doubles as the server membership `idsOf`. Point resources are never
 * preloaded (post-mount hydration is the recorded decision — the server cannot
 * know a client's id set at snapshot time).
 */
/**
 * Whether a point id set can carry `id`: the wire form joins the set on `,`, so
 * an id must be non-empty and comma-free. An id outside that alphabet names no
 * row any point read can address — `useLiveRow` answers it `found: false`
 * rather than encoding it (which throws).
 */
export function isPointId(id: string): boolean {
  return id !== "" && !id.includes(",");
}

export function pointQueryResourceDescriptor<Row>(
  key: string,
  rowSchema: ZodParser<Row>,
  pkField: keyof Row & string,
): PointQueryResourceContract<Row> {
  const encode = (ids: readonly string[]): PointParams => {
    for (const id of ids) {
      if (!isPointId(id)) {
        throw new Error(
          `pointQueryResourceDescriptor("${key}").encode: ids must be non-empty and ` +
            `comma-free, got ${JSON.stringify(id)}`,
        );
      }
    }
    return { ids: [...new Set(ids)].sort().join(",") };
  };
  const decode = (params: Record<string, string>): string[] => {
    const raw = params.ids;
    if (raw === undefined) {
      throw new ResourceContractError(
        key,
        `pointQueryResourceDescriptor("${key}").decode: params.ids is missing — a ` +
          `point subscription has no meaning without an id set`,
      );
    }
    return raw === "" ? [] : raw.split(",");
  };
  // The gate is stricter than `decode` (which, as the membership `idsOf`, reads
  // only `ids`): a point tuple is exactly `{ ids }`, so any other key is a
  // subscription this declaration never minted.
  const validateParams = (params: Record<string, string>): void => {
    for (const k of Object.keys(params)) {
      if (k !== "ids") {
        throw new ResourceContractError(
          key,
          `pointQueryResourceDescriptor("${key}"): unknown param "${k}"`,
        );
      }
    }
    decode(params);
  };

  const d = keyedRows<Row, PointParams>(key, rowSchema, pkField, {
    validateParams,
  });
  return Object.assign(d, { point: { encode, decode }, queryPk: pkField });
}

/**
 * Declare the whole ordered set of a collection declared `all` — the
 * `AllQueryResourceContract`: ONE keyed resource holding every row in
 * `orderBy` order. No window codec and no `defaultParams`, no placeholder.
 *
 * - Without `by`: param-less (boot hydrates the `{}` tuple, exactly the tuple
 *   `useLive(all)` subscribes to), and any param is a subscription this
 *   declaration never minted — the gate throws `ResourceContractError`, so
 *   the runtime refuses it as `contract-mismatch` (a `skew` verdict for a tab
 *   on an older bundle that sent params). It is NO signal against a
 *   param-less predecessor of the same key: that older tab subscribes `{}`,
 *   passes, and parses the new rows with its own schema — a key converted to
 *   `all` must keep the wire row identical or carry a contract the runtime
 *   compares on `{}` (P8 v3, C39 open item).
 * - With `by` (a scoped set): a tuple is exactly the `by` keys, each a
 *   non-empty string (`{ pageId }`); `{}`, a missing, an extra or an empty
 *   key is `contract-mismatch`. The server gate adds what only it knows —
 *   each value the canonical text of its column's type.
 *
 * Self-registers under `key` (C39), so boot-snapshot hydration resolves the
 * key's snapshot against it before first paint.
 */
export function allResourceDescriptor<Row, B extends string = never>(
  key: string,
  rowSchema: ZodParser<Row>,
  pkField: keyof Row & string,
  opts: {
    all: AllQueryResourceContract<Row, B>["all"];
    preload?: ResourcePreload;
  },
): AllQueryResourceContract<Row, B> {
  const by: readonly string[] =
    (opts.all as { by?: readonly string[] }).by ?? [];
  const validateParams = (params: Record<string, string>): void => {
    const names = Object.keys(params);
    if (by.length === 0) {
      if (names.length > 0) {
        throw new ResourceContractError(
          key,
          `allResourceDescriptor("${key}"): unknown param${names.length > 1 ? "s" : ""} ` +
            `${names.map((n) => `"${n}"`).join(", ")} — the whole ordered set takes none`,
        );
      }
      return;
    }
    const scope = by.map((f) => `"${f}"`).join(", ");
    for (const n of names) {
      if (!by.includes(n)) {
        throw new ResourceContractError(
          key,
          `allResourceDescriptor("${key}"): unknown param "${n}" — a tuple of this scoped set is exactly ${scope}`,
        );
      }
    }
    for (const f of by) {
      const v: unknown = params[f];
      if (typeof v !== "string" || v === "") {
        throw new ResourceContractError(
          key,
          `allResourceDescriptor("${key}"): param "${f}" must be a non-empty string, got ${JSON.stringify(v)} — a tuple of this scoped set is exactly ${scope}`,
        );
      }
    }
  };
  const d = keyedRows<Row, Record<string, string>>(key, rowSchema, pkField, {
    ...(opts.preload === undefined ? {} : { preload: opts.preload }),
    validateParams,
  });
  return Object.assign(d, {
    all: opts.all,
    queryPk: pkField,
  }) as unknown as AllQueryResourceContract<Row, B>;
}
