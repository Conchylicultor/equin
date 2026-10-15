import { useMemo, type ComponentType, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  defineRenderSlot,
  renderIsolated,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type {
  DataViewId,
  FieldDef,
  FieldExtensionProps,
  FieldExtensionsDescriptor,
} from "../../core";

export interface FieldExtensionContribution<TRow> {
  id: string;
  /**
   * The heading this contributor's fields are listed under in every "choose a
   * field" surface — the arm's own name on the merged run surface ("Build",
   * "Deploy"), so a schema of forty columns from five plugins reads as five
   * short lists instead of one flat one.
   *
   * `null` means the opposite, deliberately: these fields are ORDINARY fields of
   * the host's own schema (one `Starred` boolean on the pages sidebar), and get
   * no band of their own. Required and nullable rather than optional, because
   * the two answers are a real choice and the wrong one is invisible — an arm
   * that merely forgot would file its columns under the host's own name.
   */
  section: string | null;
  component: ComponentType<FieldExtensionProps<TRow>>;
  order?: number;
}

/**
 * The minted value. Unlike `ItemActions` (whose `ItemActionsDescriptor` adds a
 * *new* `.Row` member), the `FieldExtensionsDescriptor` surface (`id` +
 * `useContributions`) is ALREADY provided by `RenderSlot` — so we extend only
 * `RenderSlot` (extending both would be a duplicate-member conflict, TS2320). The
 * slot is structurally assignable to `FieldExtensionsDescriptor`, which is all the
 * fold needs.
 */
export interface FieldExtensions<TRow> extends RenderSlot<
  FieldExtensionContribution<TRow>
> {}

/**
 * Mint the field-extension slot. Internal: its one use is the global
 * `DataViewSlots.FieldExtension` (custom-columns' user-defined columns) — a
 * list's own fields are derived from its collection, row kind and client
 * fields (`./derived-fields.tsx`), never contributed per list.
 */
export function defineFieldExtensions<TRow>(): FieldExtensions<TRow> {
  return defineRenderSlot<FieldExtensionContribution<TRow>>({
    docLabel: (p) => p.id,
  });
}

/**
 * Host fold. Folds an ORDERED LIST of field-extension sources into one merged
 * schema: it recursively mounts each contributor of `sources[0]`, then each of
 * `sources[1]`, etc., threading the accumulated fields through nested
 * render-callbacks — every contributor mounts (running its own hooks), hands back
 * its `FieldDef[]` via `render`, and that recurses to the next contributor (then
 * the next source) — finally calling `children([...base, ...allExtra])`.
 *
 * The one call site passes `[DataViewSlots.FieldExtension, ...(fieldExtensions
 * prop if present)]`: the always-on global slot first (cross-cutting contributors
 * like custom-columns), then the optional per-consumer factory (Sonata's typed
 * fields). Both share this one fold; `{ storageKey, rowKey }` is threaded to every
 * contributor, and a contributor that doesn't need the coordinates ignores them.
 *
 * Written as recursive COMPONENTS (both source-level and contribution-level),
 * never a `.map` over contributed hooks: mounting each source/contributor as its
 * own React element keeps the per-component hook order stable (the source list and
 * each contribution set are fixed at build time → recursion depth is stable →
 * `react-hooks/rules-of-hooks` is satisfied). Empty source list → `children(base)`
 * directly.
 *
 * This generalizes Sonata's deleted `Library.Sort` render-callback to the field
 * level.
 */
export function CollectFieldExtensions(props: {
  sources: FieldExtensionsDescriptor<unknown>[];
  base: FieldDef<unknown>[];
  /** Surface coordinates threaded into every contribution's render props alongside
   *  `render`, so a contributor can key its per-row data over the surface. */
  storageKey: DataViewId;
  rowKey: (row: unknown, index: number) => string;
  /** See `FieldExtensionProps.liveColumnScope`. */
  liveColumnScope: string | null;
  /**
   * Checks one contributor's fields against the surface's data origin, and
   * throws on a bad one. Run INSIDE the contributor's `render(fields)` — so
   * its own error boundary contains the crash, and the error names it.
   */
  validate: Validate;
  children: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { sources, base, storageKey, rowKey, liveColumnScope, validate } =
    props;
  return (
    <FieldExtensionSourceStep
      sources={sources}
      index={0}
      acc={base}
      surface={{ storageKey, rowKey, liveColumnScope }}
      validate={validate}
      emit={props.children}
    />
  );
}

/** The surface coordinates threaded to every contributor beside `render`. */
type Surface = Omit<FieldExtensionProps<unknown>, "render">;

/** Checks a contributor's fields (see `CollectFieldExtensions.validate`); `contributor` names it. */
type Validate = (fields: FieldDef<unknown>[], contributor: string) => void;

/** Stamp one contributor's `section` over every field it returned. `null` (the
 *  fields are ordinary host fields) passes the array through untouched, so the
 *  common case allocates nothing. */
function sectioned(
  fields: FieldDef<unknown>[],
  section: string | null,
): FieldDef<unknown>[] {
  if (section === null) return fields;
  return fields.map((field) => ({ ...field, section }));
}

/** One source-level fold level: fold every contribution of `sources[index]` into
 *  `acc`, then recurse to the next source. Base case (all sources folded) → emit
 *  the merged set. A source with zero contributions passes its accumulator
 *  through (via `FieldExtensionFold`'s own base case). */
function FieldExtensionSourceStep(props: {
  sources: FieldExtensionsDescriptor<unknown>[];
  index: number;
  acc: FieldDef<unknown>[];
  surface: Surface;
  validate: Validate;
  emit: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { sources, index, acc, surface, validate, emit } = props;
  // Every source has folded its contributions into `acc` → emit.
  if (index >= sources.length) return <>{emit(acc)}</>;
  return (
    <FieldExtensionFold
      descriptor={sources[index]!}
      base={acc}
      surface={surface}
      validate={validate}
      emit={(merged) => (
        <FieldExtensionSourceStep
          sources={sources}
          index={index + 1}
          acc={merged}
          surface={surface}
          validate={validate}
          emit={emit}
        />
      )}
    />
  );
}

/** Reads one source's `useContributions()` once, then kicks off the recursive
 *  contribution-level fold. */
function FieldExtensionFold(props: {
  descriptor: FieldExtensionsDescriptor<unknown>;
  base: FieldDef<unknown>[];
  surface: Surface;
  validate: Validate;
  emit: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const { descriptor, base, surface, validate, emit } = props;
  const contributions = descriptor.useContributions();
  return (
    <FieldExtensionStep
      slot={descriptor}
      contributions={contributions}
      index={0}
      base={base}
      surface={surface}
      validate={validate}
      emit={emit}
    />
  );
}

/** One fold level: mount contribution `index` isolated; its `render` recurses to
 *  the next level with the accumulated fields. Base case → emit the merged set. */
function FieldExtensionStep(props: {
  slot: SlotHandle;
  contributions: ReturnType<
    FieldExtensionsDescriptor<unknown>["useContributions"]
  >;
  index: number;
  /** The fields folded before the previous contributor. */
  base: FieldDef<unknown>[];
  /** The previous contributor's own fields (absent on the first step:
   *  nothing to append yet) and the section they are stamped with. */
  added?: FieldDef<unknown>[];
  addedSection?: string | null;
  surface: Surface;
  validate: Validate;
  emit: (fields: FieldDef<unknown>[]) => ReactNode;
}): ReactNode {
  const {
    slot,
    contributions,
    index,
    base,
    added,
    addedSection,
    surface,
    validate,
    emit,
  } = props;
  // The previous contributor's fields, appended to the accumulator HERE (in a
  // memo) rather than in its `render` callback: an inline spread there minted a
  // new schema array on every render of the surface, so every reader of the
  // merged fields — each list row, through the view's per-row config — saw a
  // changed schema whenever anything above re-rendered. Memoized, the schema
  // keeps its identity while the base and every contributor's fields do.
  //
  // The section is STAMPED here, never read off the returned field: it is a
  // fact about who contributed, so the contributor declares it once on its
  // registration and cannot spell it differently (or forget it) on the
  // fortieth column. `null` → the fields stay un-sectioned, i.e. part of the
  // host's own set.
  const acc = useMemo(
    () =>
      // A contributor adding nothing (often a fresh `[]`) keeps the schema.
      added === undefined || added.length === 0
        ? base
        : [...base, ...sectioned(added, addedSection ?? null)],
    [base, added, addedSection],
  );
  // Every contributor has mounted and folded its fields into `acc` → emit.
  if (index >= contributions.length) return <>{emit(acc)}</>;

  const contribution = contributions[index]!;
  // Thread the surface coordinates `{ storageKey, rowKey }` alongside `render`.
  // A contributor that doesn't need them (e.g. Sonata's play-count) ignores them.
  const renderNext = (fields: FieldDef<unknown>[]) => (
    <FieldExtensionStep
      slot={slot}
      contributions={contributions}
      index={index + 1}
      base={acc}
      added={fields}
      addedSection={contribution.section}
      surface={surface}
      validate={validate}
      emit={emit}
    />
  );
  const renderProps: FieldExtensionProps<unknown> = {
    ...surface,
    render: (fields) => {
      // Called during the contributor's own render, so a throw here is caught
      // by ITS error boundary (the `renderIsolated` below) and names it.
      validate(
        fields,
        `${contribution.id}${
          (contribution as { _pluginId?: string })._pluginId
            ? ` (${(contribution as { _pluginId?: string })._pluginId})`
            : ""
        }`,
      );
      return renderNext(fields);
    },
  };
  // `renderIsolated` unseals the contribution's component and wraps it in the
  // error-boundary item middleware: a broken contributor (a throw in its hooks,
  // or a field its `validate` refuses) is caught and named there, and never
  // poisons the merged schema. The rest of the fold renders INSIDE this
  // contributor (through `render`), so the fallback stands in for the whole
  // surface below it, not only for its own fields.
  return renderIsolated(
    slot,
    contribution as unknown as Contribution,
    renderProps,
  );
}
