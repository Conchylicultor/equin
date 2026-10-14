import { describe, expect, test } from "bun:test";
import {
  PROTOCOL,
  VOCABULARY,
  protocolIdOf,
  type ClientFrame,
  type ExactClientFrame,
  type ExactServerFrame,
  type ServerFrame,
} from "./frames";

/** `v` with every object's keys in reverse order — the same value, spelled otherwise. */
function reversedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reversedKeys(x)]),
    );
  }
  return v;
}

describe("PROTOCOL — the frame vocabulary's id", () => {
  test("is the id of the vocabulary", () => {
    expect(PROTOCOL).toBe(protocolIdOf(VOCABULARY));
  });

  test("is stable across key order: how the vocabulary is written is no part of it", () => {
    const reversed = reversedKeys(VOCABULARY);
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(VOCABULARY));
    expect(protocolIdOf(reversed)).toBe(PROTOCOL);
  });

  test("changes when a field is added to a frame", () => {
    const grown = {
      ...VOCABULARY,
      server: {
        ...VOCABULARY.server,
        update: {
          ...VOCABULARY.server.update,
          fields: {
            ...VOCABULARY.server.update.fields,
            extra: { t: "optional", of: { t: "string" } },
          },
        },
      },
    };
    expect(protocolIdOf(grown)).not.toBe(PROTOCOL);
  });

  test("changes when a field turns optional, a frame kind is added, or a limit moves", () => {
    const optionalEpoch = {
      ...VOCABULARY,
      server: {
        ...VOCABULARY.server,
        "up-to-date": {
          ...VOCABULARY.server["up-to-date"],
          fields: {
            ...VOCABULARY.server["up-to-date"].fields,
            epoch: { t: "optional", of: { t: "string" } },
          },
        },
      },
    };
    const newKind = {
      ...VOCABULARY,
      client: {
        ...VOCABULARY.client,
        pong: { t: "object", fields: { op: { t: "literal", v: "pong" } } },
      },
    };
    const limit = {
      ...VOCABULARY,
      limits: { ...VOCABULARY.limits, deriveMaxSources: 3 },
    };
    const ids = [optionalEpoch, newKind, limit].map(protocolIdOf);
    expect(new Set([PROTOCOL, ...ids]).size).toBe(4);
  });

  test("a closed set's order is no part of it", () => {
    const reason = VOCABULARY.server["sub-error"].fields.reason;
    const values: readonly string[] = reason.v;
    expect(values).toEqual([...values].sort());
  });

  // Pinned: a change of this id is a change of the wire vocabulary — tabs of
  // the old one stop sharing a socket with tabs of the new one, and the
  // runtime refuses their derivations. Update it only alongside the frame
  // change that moved it.
  test("is pinned", () => {
    expect(PROTOCOL).toMatchInlineSnapshot(`"rp-195ce1fa131e23"`);
  });
});

// The sends' exactness is a type, so these cases are tsc's (`type-check`): each
// `@ts-expect-error` fails the build the day its line compiles.
describe("Exact…Frame — a send carries only declared fields", () => {
  const sent: string[] = [];
  const send = <F extends ServerFrame>(f: ExactServerFrame<F>): void => {
    sent.push(JSON.stringify(f));
  };
  const wire = <F extends ClientFrame>(f: ExactClientFrame<F>): void => {
    sent.push(JSON.stringify(f));
  };

  test("an undeclared field is refused however the frame was built", () => {
    const etag: string | undefined = sent.length > 99 ? "e" : undefined;
    const update = {
      kind: "update" as const,
      key: "k",
      params: {},
      value: 1,
      version: 1,
    };
    send(update);
    // A variable — no excess-property check of its own.
    const grown = { ...update, shard: 2 };
    // @ts-expect-error `shard` is no field of `update`
    send(grown);
    // A conditional spread of a declared field is fine; of an undeclared one, not.
    send({ ...update, ...(etag !== undefined ? { etag } : {}) });
    // @ts-expect-error `serverTime` is no field of `update`
    send({ ...update, ...(etag !== undefined ? { serverTime: etag } : {}) });
    // Nested: an up-to-date-batch entry, and a tab's sub-batch entry.
    const entries = [{ key: "k", params: {}, version: 1, extra: true }];
    // @ts-expect-error `extra` is no field of an up-to-date-batch entry
    send({ kind: "up-to-date-batch", epoch: "e", entries });
    const subs = [{ id: 1, key: "k", params: {}, extra: true }];
    const batch = {
      op: "sub-batch" as const,
      tabId: "t",
      build: "b",
      protocol: PROTOCOL,
      complete: true,
    };
    // @ts-expect-error `extra` is no field of a sub-batch entry
    wire({ ...batch, entries: subs });
    wire({ ...batch, entries: [{ id: 1, key: "k", params: {} }] });
    // Both `sub-ack` shapes (full and derived) share a kind; each is accepted.
    send({
      kind: "sub-ack",
      key: "k",
      params: {},
      value: 1,
      version: 1,
      epoch: "e",
    });
    send({
      kind: "sub-ack",
      key: "k",
      params: {},
      version: 1,
      epoch: "e",
      derived: { id: "d" },
    });
    // Every call runs, the refused ones included: the refusal is tsc's.
    expect(sent).toHaveLength(9);
  });
});
