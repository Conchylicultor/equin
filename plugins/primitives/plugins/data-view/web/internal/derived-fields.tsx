import { useMemo, type ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { FieldOptionMeta } from "@plugins/fields/core";
import {
  exposedColumns,
  type LiveArm,
  type LiveField,
} from "@plugins/network/plugins/live/core";
import {
  clientFieldsKey,
  collectionPresentationKey,
  presentationOwnerKey,
  renderClientFieldsResolver,
  useClientFieldsResolvers,
  useFieldPresentations,
  type ClientFieldReaders,
  type ClientFieldValues,
  type FieldPresentationSpec,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
  type StoredClientFieldsResolution,
  type StoredFieldPresentation,
} from "@plugins/network/plugins/live/web";
import type { FieldsRecord } from "@plugins/fields/core";
import type {
  DataViewRowsCollection,
  FieldDef,
  FieldOption,
  FieldOptionsResult,
  FieldOverrides,
  FieldValue,
} from "../../core";

// The fields a list DERIVES (`network/live` CLAUDE.md, "Fields"): its
// collection's own fields (picked from its entity, or its own), every field an
// extension exposes for an entity the collection reaches, and every field an
// arm of a union declares — each presented by its owner's registration
// (`FieldPresentation.Register`), else by its type's cell. The list names no
// owner and no owner names a list: what a list says of its fields is
// `overrides` by id and the `extraFields` it computes itself.

/** One registered presentation per owner key, its registrations merged. */
interface OwnerPresentation {
  readonly reads: ReadonlySet<string>;
  readonly fields: ReadonlyMap<string, FieldPresentationSpec<unknown, unknown>>;
}

/** A field whose options are read live: its id and the hook reading them. */
export interface FieldOptionsReader {
  readonly id: string;
  readonly useOptions: Hook<() => LiveFieldOptionsRead>;
}

/**
 * A client-fields resolver a list mounts (`ClientFields.Resolve`): the
 * registration, and how each of its fields reads a row once its values land.
 */
export interface ClientValuesReader {
  readonly resolution: StoredClientFieldsResolution;
  /** Field id → the derived field rebuilt over a value read (the presentation's cell applied). */
  readonly resolve: ReadonlyMap<
    string,
    {
      readonly placeholder: FieldDef<unknown>;
      readonly build: (read: (row: unknown) => unknown) => FieldDef<unknown>;
    }
  >;
}

/** What a list derives: its fields, and the live option and client value reads some of them take. */
export interface DerivedFields {
  readonly fields: FieldDef<unknown>[];
  readonly optionReaders: readonly FieldOptionsReader[];
  readonly clientReaders: readonly ClientValuesReader[];
}

/**
 * Merge every registration of one owner — several plugins may present one
 * owner's fields (a plugin presents a field another declares). Two of them
 * setting the same property of one field throws: one field, one cell.
 */
export function mergePresentations(
  registrations: readonly StoredFieldPresentation[],
): ReadonlyMap<string, OwnerPresentation> {
  const out = new Map<
    string,
    {
      reads: Set<string>;
      fields: Map<string, FieldPresentationSpec<unknown, unknown>>;
    }
  >();
  for (const r of registrations) {
    const key = presentationOwnerKey(r.owner);
    const merged = out.get(key) ?? { reads: new Set(), fields: new Map() };
    for (const f of r.reads) merged.reads.add(f);
    for (const [field, spec] of Object.entries(r.fields)) {
      const prior = merged.fields.get(field) ?? {};
      const clash = Object.keys(spec).filter((p) => Object.hasOwn(prior, p));
      if (clash.length > 0) {
        throw new Error(
          `data-view: two presentations of "${key}" set ${clash.join(", ")} of field "${field}" — one field, one presentation of each.`,
        );
      }
      merged.fields.set(field, { ...prior, ...spec });
    }
    out.set(key, merged);
  }
  return out;
}

/** A listed field's presentation: its entity's and its collection's, which may not both set one property. */
function bothSpecs(
  collectionKey: string,
  field: string,
  entity: FieldPresentationSpec<unknown, unknown> | undefined,
  own: FieldPresentationSpec<unknown, unknown> | undefined,
): FieldPresentationSpec<unknown, unknown> | undefined {
  if (entity === undefined || own === undefined) return entity ?? own;
  const clash = Object.keys(own).filter((p) => Object.hasOwn(entity, p));
  if (clash.length > 0) {
    throw new Error(
      `data-view: the entity's and collection "${collectionKey}"'s presentations both set ${clash.join(", ")} of field "${field}" — one field, one presentation of each.`,
    );
  }
  return { ...entity, ...own };
}

/** A field's declared options as data-view options, in declaration order. */
function optionsOf(
  record: Readonly<Record<string, FieldOptionMeta>> | null,
): FieldOption[] | undefined {
  if (record === null) return undefined;
  return Object.entries(record).map(([value, o]) => ({
    value,
    label: o.label,
    ...(o.variant !== undefined ? { variant: o.variant } : {}),
    ...(o.hint !== undefined ? { hint: o.hint } : {}),
    ...(o.quiet === true ? { quiet: true as const } : {}),
  }));
}

/** The presentation props a field takes from its spec (the cell is the caller's — it knows the read). */
function presented(
  spec: FieldPresentationSpec<unknown, unknown> | undefined,
): Pick<
  FieldDef<unknown>,
  "width" | "align" | "visible" | "groupable" | "header" | "icon" | "indicator"
> {
  return {
    ...(spec?.header !== undefined ? { header: spec.header } : {}),
    ...(spec?.width !== undefined ? { width: spec.width } : {}),
    ...(spec?.align !== undefined ? { align: spec.align } : {}),
    ...(spec?.visible !== undefined ? { visible: spec.visible } : {}),
    ...(spec?.groupable !== undefined ? { groupable: spec.groupable } : {}),
    ...(spec?.icon !== undefined ? { icon: spec.icon } : {}),
    ...(spec?.indicator !== undefined ? { indicator: spec.indicator } : {}),
  };
}

/**
 * One derived field, read by `read` (a row → the value of its key, or
 * `undefined` for a row that holds none — another arm's): an enum when it
 * declares options (keyed by each value's canonical spelling — over a
 * boolean or number column, in that `valueDomain`), else its type; a string
 * array is multi-valued (`values`).
 */
function derivedField(
  field: LiveField,
  read: (row: unknown) => unknown,
  spec: FieldPresentationSpec<unknown, unknown> | undefined,
  extra: Pick<FieldDef<unknown>, "column" | "section">,
): FieldDef<unknown> {
  const options = optionsOf(field.options);
  const cell = spec?.cell;
  // An enum over booleans / numbers (options keyed by their spelling) filters
  // in its values' domain.
  const valueDomain =
    (options !== undefined || spec?.useOptions !== undefined) &&
    (field.domain === "boolean" || field.domain === "number")
      ? field.domain
      : undefined;
  return {
    id: field.id,
    label: field.label,
    type: options !== undefined ? "enum" : field.typeId,
    ...(options !== undefined ? { options } : {}),
    ...(valueDomain !== undefined ? { valueDomain } : {}),
    ...(field.domain === "stringArray"
      ? { values: (row) => (read(row) as string[] | undefined) ?? [] }
      : { value: (row) => (read(row) ?? null) as FieldValue }),
    ...(field.primary ? { primary: true } : {}),
    ...(cell !== undefined
      ? {
          cell: (row) => {
            const value = read(row);
            return value === undefined ? null : cell(value, row);
          },
        }
      : {}),
    ...presented(spec),
    ...extra,
  };
}

/**
 * A union's source field — its discriminator — as an enum whose options are
 * its arms (value: the arm's kind, label: the arm's), in their declared
 * order: a fact about what is installed, never about the loaded page.
 */
function sourceField(
  field: LiveField,
  arms: readonly LiveArm<unknown, FieldsRecord, string>[],
): LiveField {
  return {
    ...field,
    options: Object.fromEntries(
      arms.map((arm) => [arm.owner.arm, { label: arm.label }]),
    ),
  };
}

/**
 * The fields `collection` derives, in declaration order — its own (picked
 * and own), then every reached exposure's, then every arm's — and the live
 * option reads of those presented with `useOptions`. Under a live source
 * (`live`) an exposed or arm field binds its column; an own one lowers under
 * its own id.
 */
export function useDerivedFields(
  collection: DataViewRowsCollection | undefined,
  live: boolean,
): DerivedFields {
  const registrations = useFieldPresentations();
  const resolvers = useClientFieldsResolvers();
  return useMemo(
    () => deriveFields(collection, live, registrations, resolvers),
    [collection, live, registrations, resolvers],
  );
}

/** {@link useDerivedFields}, pure. */
export function deriveFields(
  collection: DataViewRowsCollection | undefined,
  live: boolean,
  registrations: readonly StoredFieldPresentation[],
  resolvers: readonly StoredClientFieldsResolution[] = [],
): DerivedFields {
  if (collection === undefined)
    return { fields: [], optionReaders: [], clientReaders: [] };
  const presentations = mergePresentations(registrations);
  const fields: FieldDef<unknown>[] = [];
  const optionReaders: FieldOptionsReader[] = [];
  const add = (
    field: FieldDef<unknown>,
    spec: FieldPresentationSpec<unknown, unknown> | undefined,
  ): void => {
    fields.push(field);
    const useOptions = spec?.useOptions;
    if (useOptions !== undefined)
      optionReaders.push({ id: field.id, useOptions });
  };

  const registered = registrations.map((r) => r.owner);
  // A union's arms (a Meta-DataView's sources), in their declared order
  // (`liveArm({ order })`) — never the plugins' load order. Registered on the
  // web by each arm (`FieldPresentation.Register({ owner: arm })`, enforced by
  // `live:arms-registered`), so always known: they are both the source
  // field's options and the bands of the arms' own fields.
  const arms = registered
    .filter(
      (owner): owner is LiveArm<unknown, FieldsRecord, string> =>
        !("rowKeys" in owner) &&
        owner.kind === "live-columns" &&
        owner.owner.collection === collection.key,
    )
    .sort((a, b) => a.order - b.order);
  const discriminator = collection.arms?.discriminator;

  // Its own fields, presented by its entity's registration (the picked ones)
  // and by its own (`FieldPresentation.Register({ owner: collection })`, any
  // listed one — one property of one field set by both throws).
  {
    const entity =
      collection.from === null
        ? undefined
        : presentations.get(presentationOwnerKey(collection.from));
    const own = presentations.get(collectionPresentationKey(collection.key));
    for (const name of own?.fields.keys() ?? []) {
      if (!Object.hasOwn(collection.fields, name)) {
        throw new Error(
          `data-view: a presentation of collection "${collection.key}" names "${name}", which it lists no field of.`,
        );
      }
    }
    for (const read of entity?.reads ?? []) {
      if (!collection.rowKeys.includes(read)) {
        throw new Error(
          `data-view: the presentation of entity "${collection.from!.name}" reads "${read}", which "${collection.key}" does not carry — pick or carry it.`,
        );
      }
    }
    for (const field of Object.values(collection.fields)) {
      const spec = bothSpecs(
        collection.key,
        field.key,
        entity?.fields.get(field.key),
        own?.fields.get(field.key),
      );
      const source = field.key === discriminator;
      if (source && spec?.useOptions !== undefined) {
        throw new Error(
          `data-view: the presentation of "${collection.key}" reads options for "${field.key}", its source field — a union's source options are its registered arms (\`liveArm({ label, order })\`), never read.`,
        );
      }
      add(
        derivedField(
          source ? sourceField(field, arms) : field,
          (row) => (row as Record<string, unknown>)[field.key],
          spec,
          {},
        ),
        spec,
      );
    }
  }

  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  // The exposed fields of every entity it reaches.
  const reached = new Set(
    Object.values(collection.exposes ?? {}).map((ref) => ref.name),
  );
  for (const owner of registered) {
    if ("rowKeys" in owner || owner.kind !== "exposure") continue;
    if (!reached.has(owner.parent.name)) continue;
    const ownerKey = presentationOwnerKey(owner);
    if (!once(ownerKey)) continue;
    const columns = exposedColumns(owner);
    const presentation = presentations.get(ownerKey);
    for (const [key, exposed] of Object.entries(owner.fields)) {
      const spec = presentation?.fields.get(key);
      const wire = columns.wireName(key);
      const bound =
        Object.hasOwn(columns.wireFilterable, wire) ||
        columns.wireSortable.includes(wire);
      add(
        derivedField(
          {
            id: exposed.id,
            key,
            label: exposed.label,
            typeId: exposed.typeId,
            options: exposed.options,
            primary: false,
            domain: columns.wireFilterable[wire]?.domain ?? null,
            sortable: columns.wireSortable.includes(wire),
          },
          (row) => columns.read(row as Parameters<typeof columns.read>[0])[key],
          spec,
          live && bound ? { column: columns.column(key) } : {},
        ),
        spec,
      );
    }
  }

  // Every arm's fields, when the collection is a union — in the arms' own
  // declared order (`liveArm({ order })`), never the plugins' load order. An
  // arm `from` an entity (`reaches`) lists that entity's exposed fields after
  // its own, in its band, ids `<arm>.<id>` like its own (two entities may
  // expose one id — a task's origin and a page's).
  for (const arm of arms) {
    const ownerKey = presentationOwnerKey(arm);
    if (!once(ownerKey)) continue;
    addArmFields(arm);
    if (arm.reaches === null) continue;
    for (const owner of registered) {
      if ("rowKeys" in owner || owner.kind !== "exposure") continue;
      if (owner.parent.name !== arm.reaches.name) continue;
      addArmExposure(arm, owner);
    }
  }

  function addArmExposure(
    arm: LiveArm<unknown, FieldsRecord, string>,
    owner: Parameters<typeof exposedColumns>[0],
  ): void {
    const columns = exposedColumns(owner);
    const presentation = presentations.get(presentationOwnerKey(owner));
    const kind = arm.owner.arm;
    for (const [key, exposed] of Object.entries(owner.fields)) {
      const spec = presentation?.fields.get(key);
      const wire = columns.wireName(key);
      const bound =
        Object.hasOwn(columns.wireFilterable, wire) ||
        columns.wireSortable.includes(wire);
      add(
        derivedField(
          {
            id: `${kind}.${exposed.id}`,
            key,
            label: exposed.label,
            typeId: exposed.typeId,
            options: exposed.options,
            primary: false,
            domain: columns.wireFilterable[wire]?.domain ?? null,
            sortable: columns.wireSortable.includes(wire),
          },
          // Another arm's row carries no slice of this exposure.
          (row) =>
            (row as Record<string, unknown>)[discriminator!] === kind
              ? columns.read(row as Parameters<typeof columns.read>[0])[key]
              : undefined,
          spec,
          {
            section: arm.label,
            ...(live && bound ? { column: columns.column(key) } : {}),
          },
        ),
        spec,
      );
    }
  }

  function addArmFields(arm: LiveArm<unknown, FieldsRecord, string>): void {
    const presentation = presentations.get(presentationOwnerKey(arm));
    for (const field of Object.values(arm.listed)) {
      const spec = presentation?.fields.get(field.key);
      add(
        derivedField(
          field,
          (row) => {
            const slice = arm.read(row);
            return slice === null
              ? undefined
              : (slice as Record<string, unknown>)[field.key];
          },
          spec,
          {
            section: arm.label,
            ...(live && (field.domain !== null || field.sortable)
              ? { column: arm.column(field.key as never) }
              : {}),
          },
        ),
        spec,
      );
    }
  }

  // Every client field of the owner (`clientFields` — a row kind's, or a
  // collection's), its values resolved in the browser by its plugin
  // (`ClientFields.Resolve`) and filtered in memory: a live source, which
  // filters on the server, cannot list one.
  const clientReaders: ClientValuesReader[] = [];
  for (const resolution of resolvers) {
    const decl = resolution.fields;
    if (decl.owner !== collection.key) continue;
    const ownerKey = clientFieldsKey(decl);
    if (live) {
      throw new Error(
        `data-view: "${collection.key}" has client fields ("${ownerKey}") — their values are resolved in the browser and filtered in memory, so a live source cannot list them. List its rows in memory (\`rows\` with \`collection\`).`,
      );
    }
    if (!once(ownerKey)) {
      throw new Error(
        `data-view: client fields "${ownerKey}" are resolved twice — one \`ClientFields.Resolve\` per declaration.`,
      );
    }
    const presentation = presentations.get(ownerKey);
    const resolve = new Map<
      string,
      {
        placeholder: FieldDef<unknown>;
        build: (read: (row: unknown) => unknown) => FieldDef<unknown>;
      }
    >();
    for (const field of Object.values(decl.listed)) {
      const spec = presentation?.fields.get(field.key);
      const extra = decl.section === null ? {} : { section: decl.section };
      const build = (read: (row: unknown) => unknown): FieldDef<unknown> =>
        derivedField(field, read, spec, extra);
      const placeholder = build(() => undefined);
      add(placeholder, spec);
      resolve.set(field.id, { placeholder, build });
    }
    clientReaders.push({ resolution, resolve });
  }
  return { fields, optionReaders, clientReaders };
}

/**
 * Mount every client-fields resolver a list's owner has and hand each of its
 * fields the resolver's read — one level per resolver, keyed by its
 * declaration. Not known yet, a field is `pending` (its cells draw the loading
 * block, a view laid out by it its loading state); failed with nothing held,
 * its `readError`; else its value read. Only what the derivation put there is
 * replaced (a list's override of a cell stands).
 */
export function CollectClientValues(props: {
  readers: readonly ClientValuesReader[];
  rows: readonly unknown[];
  fields: FieldDef<unknown>[];
  children: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { readers, rows, fields, children } = props;
  if (readers.length === 0) return children(fields);
  const [first, ...rest] = readers;
  return renderClientFieldsResolver(first!.resolution, {
    rows,
    render: (values) => (
      <ClientValuesLevel
        key={clientFieldsKey(first!.resolution.fields)}
        reader={first!}
        values={values}
        fields={fields}
        render={(resolved) => (
          <CollectClientValues readers={rest} rows={rows} fields={resolved}>
            {children}
          </CollectClientValues>
        )}
      />
    ),
  });
}

function ClientValuesLevel(props: {
  reader: ClientValuesReader;
  values: ClientFieldValues<unknown, FieldsRecord>;
  fields: FieldDef<unknown>[];
  render: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { reader, values, fields, render } = props;
  const resolved = useMemo(() => {
    const readers: ClientFieldReaders<unknown, FieldsRecord> | undefined =
      values.status === "ready"
        ? values.data
        : values.status === "error"
          ? values.stale
          : undefined;
    return fields.map((f): FieldDef<unknown> => {
      const entry = reader.resolve.get(f.id);
      if (entry === undefined) return f;
      const read = readers?.[f.id];
      const built = entry.build(read === undefined ? () => undefined : read);
      // Replace only what the derivation set (an override's cell stands).
      const next: FieldDef<unknown> = {
        ...f,
        ...(f.value === entry.placeholder.value ? { value: built.value } : {}),
        ...(f.values === entry.placeholder.values
          ? { values: built.values }
          : {}),
        ...(f.cell === entry.placeholder.cell ? { cell: built.cell } : {}),
      } as FieldDef<unknown>;
      if (read !== undefined) return next;
      return values.status === "error"
        ? {
            ...next,
            readError: { error: values.error, refetch: values.refetch },
          }
        : { ...next, pending: true };
    });
  }, [fields, reader, values]);
  return render(resolved);
}

/**
 * A list's schema: its hand `fields` (no collection declared by fields) or
 * the derived ones with its `overrides` applied, then its `extraFields`.
 * Throws on `fields` beside a collection declared by fields — a tsc error
 * for a typed caller (`DataViewProps`: the live origin and the `collection`
 * arm say `fields?: never`), kept for a cast — on neither, on an override of
 * an id no derived field has (or one for another collection), and on an id
 * two fields share.
 */
export function listSchema(input: {
  collection: DataViewRowsCollection | undefined;
  derived: readonly FieldDef<unknown>[];
  fields: readonly FieldDef<unknown>[] | undefined;
  overrides: FieldOverrides<unknown> | undefined;
  extraFields: readonly FieldDef<unknown>[] | undefined;
}): FieldDef<unknown>[] {
  const { collection, derived, fields, overrides, extraFields } = input;
  const who =
    collection === undefined ? "this DataView" : `"${collection.key}"`;
  const declaredByFields = collection !== undefined;
  if (declaredByFields && fields !== undefined) {
    throw new Error(
      `data-view: ${who} is declared by fields — its list derives them; pass \`overrides\` (by id) and \`extraFields\`, not \`fields\`.`,
    );
  }
  if (!declaredByFields && fields === undefined) {
    throw new Error(
      `data-view: ${who} has no fields — pass \`fields\`, or list the rows' collection or row kind (\`collection\`).`,
    );
  }
  let base = [...(fields ?? []), ...derived];
  if (overrides !== undefined) {
    if (collection === undefined || overrides.collection !== collection.key) {
      throw new Error(
        `data-view: \`overrides\` are for "${overrides.collection}", but ${who} lists ${collection === undefined ? "no collection" : `"${collection.key}"`}.`,
      );
    }
    const ids = new Set(base.map((f) => f.id));
    const unknown = Object.keys(overrides.byId).filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `data-view: \`overrides\` name ${unknown.map((id) => `"${id}"`).join(", ")}, which ${who} derives no field of.`,
      );
    }
    base = base.map((f) => {
      const override = overrides.byId[f.id];
      return override === undefined
        ? f
        : ({ ...f, ...override } as FieldDef<unknown>);
    });
  }
  const all = [...base, ...(extraFields ?? [])];
  const seen = new Set<string>();
  for (const field of all) {
    if (seen.has(field.id)) {
      throw new Error(
        `data-view: field "${field.id}" is declared twice in ${who}'s schema (derived — the collection, an exposure an entity it reaches, an arm — or the list's own) — one id, one field.`,
      );
    }
    seen.add(field.id);
  }
  return all;
}

/**
 * Read every live option set (`useOptions`) and hand each field its
 * `optionsResult` — one level per reader, keyed by the field's id so a
 * reader set that changes never moves a hook to another component.
 */
export function CollectFieldOptions(props: {
  readers: readonly FieldOptionsReader[];
  fields: FieldDef<unknown>[];
  children: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { readers, fields, children } = props;
  if (readers.length === 0) return children(fields);
  const [first, ...rest] = readers;
  return (
    <FieldOptionsLevel
      key={first!.id}
      reader={first!}
      fields={fields}
      render={(withOptions) => (
        <CollectFieldOptions readers={rest} fields={withOptions}>
          {children}
        </CollectFieldOptions>
      )}
    />
  );
}

function FieldOptionsLevel(props: {
  reader: FieldOptionsReader;
  fields: FieldDef<unknown>[];
  render: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { reader, fields, render } = props;
  const { useOptions } = reader;
  const read = useOptions();
  const withOptions = useMemo(
    () =>
      fields.map((f): FieldDef<unknown> => {
        if (f.id !== reader.id) return f;
        const { options: _declared, optionsResult: _prior, ...rest } = f;
        // A single value presents as an enum of the options; a multi-valued
        // field (`values` — tags) keeps its type, whose filter takes the
        // options as a multi-select.
        const typed = {
          ...rest,
          type: f.values === undefined ? "enum" : f.type,
        };
        return { ...typed, ...optionsStateOf(read) };
      }),
    [fields, read, reader.id],
  );
  return render(withOptions);
}

const LOADING: FieldOptionsResult = { status: "loading" };

/**
 * A live option read as the field's option state. Known options (a ready
 * read, or the last ones held across a failure) are the field's `options` —
 * what its chip cell, its group-by sections and its filter input all read.
 * Not known yet, the field is `pending` (its cells draw the loading block, a
 * view laid out by it its loading state — never raw-id chips and sections
 * that relabel when the options land) and its filter input renders the
 * read's loading arm; failed with nothing held, its `readError`.
 */
type OptionsState =
  | { options: FieldOption[] }
  | {
      optionsResult: FieldOptionsResult;
      pending?: true;
      readError?: NonNullable<FieldDef<unknown>["readError"]>;
    };

function optionsStateOf(read: LiveFieldOptionsRead): OptionsState {
  const known = (options: readonly LiveFieldOption[]): OptionsState => ({
    options: options.map((o) => ({ ...o })),
  });
  // An always-known set (a contribution registry) is its options.
  if (!("status" in read)) return known(read);
  switch (read.status) {
    case "loading":
      return { optionsResult: LOADING, pending: true };
    case "error":
      return read.stale !== undefined
        ? known(read.stale)
        : {
            optionsResult: read,
            readError: { error: read.error, refetch: read.refetch },
          };
    case "ready":
      return known(read.data);
  }
}
