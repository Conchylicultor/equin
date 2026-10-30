import { is, SQL } from "drizzle-orm";
import type {
  HandoffDefinitionAnswer,
  ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import { describeSchema } from "@plugins/packages/plugins/zod-introspect/core";
import type { PointArmPlan } from "./arm-plan";
import { decoderId, renderQuery, sha256 } from "./fingerprint";
import { decoderOfRead } from "./raw-sql";

// The DEFINITION of a compiled point read (`:rows`): a sha256 over everything
// that decides the value a load produces — the point SQL as the database
// receives it, how each field is decoded, the row schema the runtime parses
// it through, the encode step, the id bound. The same discipline as the `all`
// compile's L2 definition (`./fingerprint`, A18 / A40), for a different
// consumer: the epoch handoff (resource-runtime's `resumeEpoch`) inherits a
// tuple across a restart only when the running entry's definition equals the
// one the previous process served it under — so a deploy that moves any of
// these reloads it.
//
// FAIL-CLOSED: anything whose effect a definition cannot pin — a `where` that
// is a function of the params, an `encodeRow` that names no id, an opaque
// decoder, a param that is not a literal, a schema part whose output depends
// on a function body — yields NO definition (`none`, with why), and an entry without
// one is never inherited. Unlike the `all` compile this never throws: a point
// read with no definition is legitimate, it only loses the handoff.
//
// Bump on any change to the point compile or the point codec that moves what
// a load produces with none of the inputs below moving.
const POINT_DEFINITION_VERSION = 1;

/** Why a point definition gave up — internal, turned into `null`. */
class NoDefinition extends Error {}

const giveUp = (message: string): never => {
  throw new NoDefinition(message);
};

// The placeholder id the point query is rendered at: the ids ride as ONE
// array param, so the SQL text does not depend on them.
const PLACEHOLDER_ID = "__definition__";

export interface PointDefinitionInput<P extends ResourceParams> {
  arm: PointArmPlan<unknown, P>;
  /** The spec's `where` — a function of the params cannot be pinned. */
  where: SQL | ((params: P) => SQL | undefined) | undefined;
  /** The params naming the placeholder id (the descriptor's `point.encode`). */
  encode: (ids: readonly string[]) => P;
  /** The descriptor's row-array schema, parsed over every load. */
  schema: unknown;
  /** The descriptor's id bound (`point.maxIds`). */
  maxIds: number;
  /** Whether the spec declares an `encodeRow`, and its id if it names one. */
  encodeRow: { declared: false } | { declared: true; id: string | undefined };
}

/** The point read's definition, or why it has none (anything in it opaque). */
export function pointDefinition<P extends ResourceParams>(
  input: PointDefinitionInput<P>,
): HandoffDefinitionAnswer {
  try {
    if (typeof input.where === "function") {
      giveUp("a function `where`");
    }
    if (input.encodeRow.declared && input.encodeRow.id === undefined) {
      giveUp("an `encodeRow` with no id");
    }
    const { description, opaque } = describeSchema(input.schema);
    if (opaque.length > 0) {
      giveUp(`an opaque row-schema part (${opaque.join("; ")})`);
    }
    const params = input.encode([PLACEHOLDER_ID]);
    const query = input.arm.pointQuery(params, [PLACEHOLDER_ID]);
    const rendered = renderQuery(query.getSQL(), "the point shape", giveUp);
    const definition = sha256(
      JSON.stringify({
        v: POINT_DEFINITION_VERSION,
        point: rendered,
        keyField: input.arm.keyField,
        fields: input.arm.projection.map((f) => [
          f.outer,
          decoderId(
            // An aliased expression decodes through the SQL it aliases.
            decoderOfRead(is(f.read, SQL.Aliased) ? f.read.sql : f.read),
            `field "${f.outer}"`,
            giveUp,
          ),
        ]),
        row: description,
        maxIds: input.maxIds,
        encodeRow: input.encodeRow.declared ? input.encodeRow.id : null,
      }),
    );
    return { kind: "defined", definition };
  } catch (err) {
    if (err instanceof NoDefinition)
      return { kind: "none", reason: err.message };
    throw err;
  }
}
