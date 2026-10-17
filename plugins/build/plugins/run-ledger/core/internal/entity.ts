import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { buildRunIdKind } from "./id-kind";

// The `build_runs` entity, by reference: its name and its fields as the wire
// carries them — what a browser-safe declaration names a build run WITH (the
// runs union's build arm `from`, an extension shape's `exposes.parent`), so a
// field a plugin exposes on a build run lands in every list of build runs. The
// table is built from it (`server/internal/tables.ts`, `defineEntity`), with
// `pid` as its one server field (never on the wire).

/** A build run's fields, as the wire reads them; the labelled ones are what a list shows. */
export const buildRunFields = {
  id: idKindField(buildRunIdKind),
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
