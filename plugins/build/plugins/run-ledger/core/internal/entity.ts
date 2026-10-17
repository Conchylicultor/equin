import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";

// The `build_runs` entity, by reference: its name and its fields as the wire
// carries them — what a browser-safe declaration names a build run WITH (the
// runs union's build arm `from`, an extension shape's `exposes.parent`), so a
// field a plugin exposes on a build run lands in every list of build runs. It
// is the one record of a build run's fields: `build.history` carries its
// fields from here too.
//
// The table itself stays a raw `pgTable` (`server/internal/tables.ts`), not
// built from this record by `defineEntity`, for three reasons:
//
// - `defineEntity` is server-only and loads the field-storage manifest; the
//   detached `./singularity build` CLI imports this leaf's server barrel, and
//   a regenerating CLI may not load that manifest
//   (`cli:codegen-manifests-not-frozen`).
// - `targets` is a `text[]`, which no field storage produces.
// - `id` is branded (`idColumn(buildRunIdKind)`, tolerating the legacy
//   `<commit>-<ms>` ids).
//
// So this record states the wire half, and the server binds it to the
// table's columns by name — an arm picking a field the table has no column of
// that name and type for must bind it itself (tsc, `served.arm`'s `extra`).
// `pid` is internal (stripped from every payload), so it is no field here.

/** A build run's fields, as the wire reads them; the labelled ones are what a list shows. */
export const buildRunFields = {
  id: textField(),
  trigger: enumTextField(["manual", "auto"] as const),
  commitHash: nullable(textField({ label: "Commit" })),
  namespace: textField(),
  // One invocation is one row with N target chips; filtering "contains
  // sonata" means one chip, not a substring of a joined string.
  targets: stringListField({ label: "Targets" }),
  startedAt: dateField(),
  finishedAt: nullable(dateField()),
  // The one fact that separates two builds sharing a status.
  exitCode: nullable(intField({ label: "Exit code" })),
} satisfies FieldsRecord;

/** The `build_runs` entity — every build run, of every namespace. */
export const buildRunsEntityRef = entityRef("build_runs", buildRunFields);
