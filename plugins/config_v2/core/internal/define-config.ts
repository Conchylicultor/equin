import type {
  ConfigDescriptor,
  ConfigValues,
  ConfigSource,
  OriginDefaultsFrom,
  SeedCondition,
} from "./types";
import type { DefaultedFields, FieldsRecord } from "@plugins/fields/core";
import type { ConfigMigration } from "./config-migration";
import { fieldDefaults, fieldsToZodObject } from "@plugins/fields/core";

interface DefineConfigOpts<F extends FieldsRecord> {
  name?: string;
  // A config is seeded from its fields' defaults: each needs one (tsc).
  fields: F & DefaultedFields<F>;
  scope?: "app";
  source?: ConfigSource;
  overrideLegend?: readonly string[];
  migrations?: readonly ConfigMigration[];
  requiresAuthoredOverride?: {
    guidance: string[];
    seedWhen?: SeedCondition;
  };
}

// Two overloads rather than one signature inferring `O` from the property. With
// an optional `originDefaultsFrom?: O` and no `exactOptionalPropertyTypes`, a
// caller passing `cond ? "build" : undefined` — or any variable typed as the
// union — makes `O` fall back to its CONSTRAINT, silently handing back a
// descriptor typed as both arms at once. That is exactly the widening the
// declaration exists to prevent, so `O` is never inferred: each overload names
// the arm it returns.
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom?: "descriptor" },
): ConfigDescriptor<F, "descriptor">;
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom: "build" },
): ConfigDescriptor<F, "build">;
export function defineConfig<const F extends FieldsRecord>(
  opts: DefineConfigOpts<F> & { originDefaultsFrom?: OriginDefaultsFrom },
): ConfigDescriptor<F> {
  for (const key of Object.keys(opts.fields)) {
    if (key.includes(".")) {
      throw new Error(
        `defineConfig: field name "${key}" must not contain "." (used as key separator).`,
      );
    }
  }

  // The seeded/re-marked override carries the descriptor's own prose as its
  // instructions — an empty `guidance` would produce a bare marker the author
  // has no way to act on, so it is a defect at declaration time, not a silent
  // degradation at build time.
  const ids = (opts.migrations ?? []).map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `defineConfig: "${opts.name ?? "config"}" declares a migration id twice (${ids.join(", ")}).`,
    );
  }

  // `seedWhen` is data naming a field: a field the config does not declare
  // would never seed and never say so.
  const seedField = opts.requiresAuthoredOverride?.seedWhen?.field;
  if (seedField !== undefined && !(seedField in opts.fields)) {
    throw new Error(
      `defineConfig: "${opts.name ?? "config"}" seeds when "${seedField}" has entries, but declares no such field.`,
    );
  }

  if (opts.requiresAuthoredOverride?.guidance.length === 0) {
    throw new Error(
      `defineConfig: "${opts.name ?? "config"}" sets requiresAuthoredOverride with empty guidance — supply the prose the author is meant to act on.`,
    );
  }

  const defaults = fieldDefaults(
    opts.fields,
    `defineConfig("${opts.name ?? "config"}")`,
  ) as ConfigValues<F>;

  // The schema is composed on first read, not here. A descriptor is declared
  // at module evaluation — ~100 of them on every page load, most never parsed
  // in the browser (the server resolves documents) — and composing one builds
  // a zod object over every field and checks each field's default against its
  // own schema (`fieldsToZodObject` → `assertFieldDefault`). Composed once,
  // memoized: every reader sees the same schema. A bad default still fails
  // loudly: `config-v2:registrations-paired` composes every registered
  // descriptor's schema and parses its defaults at build, and the server
  // composes it resolving the config's document (a FieldDefaultError naming
  // the field type).
  //
  // .passthrough() for parity with object/list: unknown keys are preserved, not
  // stripped (redaction/tiers iterate descriptor.fields explicitly anyway).
  // `fieldsToZodObject` returns a STRICT object — config applies passthrough
  // here, where the old `buildFieldsSchema` used to bake it in.
  let schema: ConfigDescriptor<F>["schema"] | undefined;
  const fields = opts.fields;

  return Object.freeze({
    name: opts.name ?? "config",
    get schema() {
      return (schema ??= fieldsToZodObject(fields).passthrough());
    },
    fields: opts.fields,
    defaults,
    originDefaultsFrom: opts.originDefaultsFrom ?? "descriptor",
    scope: opts.scope,
    source: opts.source ?? "manual",
    overrideLegend: opts.overrideLegend,
    migrations: opts.migrations ?? [],
    requiresAuthoredOverride: opts.requiresAuthoredOverride,
  });
}
