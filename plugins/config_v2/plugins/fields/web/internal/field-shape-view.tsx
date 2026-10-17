import type {
  ChoiceOption,
  FieldShape,
} from "@plugins/config_v2/plugins/fields/core";
import type { FieldDef } from "@plugins/fields/core";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  ControlPanel,
  ControlPanelPopover,
  useControlPanelHost,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type React from "react";
import { useId, useState } from "react";

import {
  ConfigFieldAdornmentsProvider,
  useConfigFieldAdornments,
  type ConfigFieldAdornments,
} from "./field-adornments";
import { FieldRenderer } from "./field-renderer";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

/**
 * THE THRESHOLD, and it lives here because it is a PRESENTATION decision.
 *
 * Up to this many single- or multi-select options, a choice is a band of rows in
 * the panel's own selection language (invariant #3). Above it, the options no
 * longer fit as rows and the field becomes a picker.
 *
 * It is ONE constant, and it replaces the `options.length <= 3` heuristic that
 * used to live inside `enum-renderer` and again inside `dynamic-enum-renderer` —
 * the clearest example of a decision a field must never make. If a host ever
 * needs a different number it becomes another field on `ControlPanelHost`, never
 * a prop on a field.
 */
const CHOICE_ROWS_MAX = 6;

type ChoiceShape = Extract<FieldShape, { kind: "choice" }>;
type GroupShape = Extract<FieldShape, { kind: "group" }>;
type ListShape = Extract<FieldShape, { kind: "list" }>;

/** Nothing to adorn — the ordinary case, and the whole of every popover. */
const NO_ADORNMENTS: ConfigFieldAdornments = {};

/**
 * THE ONE FILE IN THE REPO THAT IMPORTS `ControlPanel` ON BEHALF OF A CONFIG
 * FIELD.
 *
 * A renderer declares what its field IS (`FieldShape`); this maps that onto the
 * vocabulary — which member, which band, where the label goes, where the
 * description goes, which selection language. Eighteen field types therefore
 * make ZERO presentation decisions between them, which is why they cannot
 * disagree with each other or with the panel around them.
 *
 * Grouping is DERIVED here, never declared on a descriptor. `FieldMeta` gains
 * nothing and `ConfigDescriptor` gains nothing: an explicit `group`/`order` pair
 * would be a rung-5 request that 80 descriptors would have to be revisited to
 * satisfy, that nothing enforces, and that drifts the first time someone adds a
 * field and forgets the name. A named settings section is already expressible
 * and it is a field type — `objectField({ label: "Appearance", subFields })`.
 */
export function FieldShapeView({
  field,
  shape,
}: {
  field: FieldDef;
  shape: FieldShape;
}) {
  const host = useControlPanelHost();
  const adornments = useConfigFieldAdornments();
  // The `descriptions` policy, applied ONCE, here. `"hint"` (a popover, which
  // passes field subsets precisely because it wants short labels rather than
  // prose) turns every description into a tooltip; `"band"` (a pane, where most
  // config descriptions are real paragraphs that behind a hover would be
  // invisible on touch, unreachable by ⌘F and gone for anyone reading down the
  // page) keeps them visible on a band.
  const onBand = host.descriptions === "band";
  const description = field.meta.description;
  return (
    // The adornments are CONSUMED here and cleared for everything below. A group
    // renders its sub-fields back through the dispatch, and those sub-fields are
    // not the field the host adorned — without this, one modified object field
    // would stripe, badge and offer a reset on every field inside it.
    <ConfigFieldAdornmentsProvider value={null}>
      <ShapeMember
        label={field.meta.label ?? ""}
        hint={onBand ? undefined : description}
        // A field that carries prose is its own subject, so it is its own BAND —
        // in either host. Only WHERE the prose is shown differs by host, which is
        // why this reads the description itself rather than the rendered one:
        // keyed on the rendered one, a popover banded nothing at all and a run of
        // unrelated toggles ran together with no rule between them.
        band={description != null}
        description={onBand ? description : undefined}
        adornments={adornments}
        shape={shape}
      />
    </ConfigFieldAdornmentsProvider>
  );
}

interface ShapeMemberProps {
  label: React.ReactNode;
  hint?: string;
  /** Whether this field is a band of its own. See `Banded`. */
  band?: boolean;
  description?: React.ReactNode;
  /**
   * What the HOST says about this field — `null` when the host adorns nothing,
   * which is every popover. See `field-adornments` for why presence and content
   * are separate questions.
   */
  adornments?: ConfigFieldAdornments | null;
  /**
   * A trailing cluster the CALLER supplies, independent of the host — today only
   * a list item's Remove. It is merged into the host's own `actions`.
   */
  actions?: React.ReactNode;
  shape: FieldShape;
}

function ShapeMember({
  label,
  hint,
  band = false,
  description,
  adornments,
  actions,
  shape,
}: ShapeMemberProps) {
  const host = adornments ?? NO_ADORNMENTS;
  const { mark, status, note } = host;
  const rowActions = mergeActions(host.actions, actions);
  // WHICH MEMBER CAN HOLD WHAT THE HOST HAS TO SAY.
  //
  // A badge and a hover-revealed reset need a row that is a plain `<div>` — a
  // `Setting`, a `Block`, or a `Group`'s inline header. A `ControlPanel.Row` is
  // its own click target, so an action inside it would be a `<button>` in a
  // `<button>`, and a `Section` label is an eyebrow rather than a row. So an
  // adorned field renders in the LABELLED-ROW form of its shape: the same
  // members its long forms already use, chosen for the surface rather than for
  // the value.
  //
  // Keyed on whether the host adorns AT ALL, never on whether it currently has
  // something to say — a toggle that turned into a different control the moment
  // it was edited would be the worst of both.
  const labelledRow = adornments != null;
  switch (shape.kind) {
    case "toggle":
      if (labelledRow) {
        return (
          <Banded band={band} description={description}>
            <ControlPanel.Setting
              label={label}
              hint={hint}
              fit="inline"
              control={
                <Switch
                  checked={shape.checked}
                  onCheckedChange={shape.onToggle}
                  aria-label={typeof label === "string" ? label : undefined}
                />
              }
              status={status}
              actions={rowActions}
              mark={mark}
              note={note}
            />
          </Banded>
        );
      }
      return (
        <Banded band={band} description={description}>
          <ControlPanel.Row
            select="switch"
            checked={shape.checked}
            hint={hint}
            onSelect={shape.onToggle}
          >
            {label}
          </ControlPanel.Row>
        </Banded>
      );
    case "value":
      return (
        <Banded band={band} description={description}>
          <ControlPanel.Setting
            label={label}
            hint={hint}
            control={shape.control}
            fit={shape.fit}
            status={status}
            actions={rowActions}
            mark={mark}
            note={note}
          />
        </Banded>
      );
    case "block":
      // `Block` carries its description VISIBLY, under the label and above the
      // control, so it needs no band of its own.
      return (
        <ControlPanel.Block
          label={label}
          hint={hint}
          description={description}
          status={status}
          actions={rowActions}
          mark={mark}
          note={note}
        >
          {shape.control}
        </ControlPanel.Block>
      );
    case "choice":
      return (
        <ChoiceMember
          label={label}
          hint={hint}
          description={description}
          adornments={adornments}
          actions={rowActions}
          shape={shape}
        />
      );
    case "group":
      return (
        <ControlPanel.Group
          label={label}
          hint={hint}
          description={description}
          status={status}
          actions={rowActions}
          mark={mark}
          note={note}
        >
          <GroupFields shape={shape} />
        </ControlPanel.Group>
      );
    case "list":
      return (
        <ListMember
          label={label}
          hint={hint}
          description={description}
          adornments={adornments}
          actions={rowActions}
          shape={shape}
        />
      );
  }
}

/** Both clusters land in one `RowActions`, so the host's reset and a list item's
 *  Remove share one reveal and one density rather than two competing ones. */
function mergeActions(
  hostActions: React.ReactNode,
  ownActions: React.ReactNode,
): React.ReactNode {
  if (hostActions == null) return ownActions;
  if (ownActions == null) return hostActions;
  return (
    <>
      {ownActions}
      {hostActions}
    </>
  );
}

/**
 * A field that is its own subject is its own single-member `Section`; one that
 * is a bare option stays a bare member, so a run of them bands together with no
 * hairline between.
 *
 * The description reserves no track and takes no row height, so invariant #2
 * never sees it — which is the whole reason the prose lives on the band rather
 * than as a second line in the row.
 */
function Banded({
  band,
  description,
  children,
}: {
  band: boolean;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!band) return children;
  return (
    <ControlPanel.Section description={description}>
      {children}
    </ControlPanel.Section>
  );
}

function ChoiceMember({
  label,
  hint,
  description,
  adornments,
  actions,
  shape,
}: {
  label: React.ReactNode;
  hint?: string;
  description?: React.ReactNode;
  adornments?: ConfigFieldAdornments | null;
  actions?: React.ReactNode;
  shape: ChoiceShape;
}) {
  const host = adornments ?? NO_ADORNMENTS;
  const selected = new Set(shape.value);

  if (shape.options.length <= CHOICE_ROWS_MAX) {
    const rows = shape.options.map((option) => (
      <ControlPanel.Row
        key={option.value}
        select={shape.select === "one" ? "radio" : "check"}
        checked={selected.has(option.value)}
        hint={option.hint}
        onSelect={() => shape.onSelect(option.value)}
      >
        {option.label}
      </ControlPanel.Row>
    ));

    // A choice IS a band — its rows are its options — so its description simply
    // lands on that band. This is the one place the `"hint"` policy cannot be
    // honoured: a band has no row to describe, and dropping prose the user wrote
    // would be worse than showing it in a popover.
    //
    // An ADORNED choice keeps the band and moves its name off the eyebrow onto a
    // `Block` header, which is a row and can therefore hold the badge, the reset
    // and the stripe. The label lands on the same text rail as every `Setting`
    // label in the panel, so the pane reads as one column of field names.
    if (adornments != null) {
      return (
        <ControlPanel.Section>
          <ControlPanel.Block
            label={label}
            hint={hint}
            description={description ?? hint}
            status={host.status}
            actions={actions}
            mark={host.mark}
            note={host.note}
          >
            {rows}
          </ControlPanel.Block>
        </ControlPanel.Section>
      );
    }
    return (
      <ControlPanel.Section label={label} description={description ?? hint}>
        {rows}
      </ControlPanel.Section>
    );
  }

  if (shape.select === "many") {
    // Too many to be rows, and there is no multi-select panel in the vocabulary
    // — a cluster of chips is the wider-than-a-row control, which is a `Block`.
    return (
      <ControlPanel.Block
        label={label}
        hint={hint}
        description={description}
        status={host.status}
        actions={actions}
        mark={host.mark}
        note={host.note}
      >
        <Cluster gap="2xs">
          {shape.options.map((option) => (
            <ToggleChip
              key={option.value}
              variant="ghost"
              active={selected.has(option.value)}
              tooltip={option.hint}
              onClick={() => shape.onSelect(option.value)}
            >
              {option.label}
            </ToggleChip>
          ))}
        </Cluster>
      </ControlPanel.Block>
    );
  }

  return (
    <Banded band={description != null} description={description}>
      <ControlPanel.Setting
        label={label}
        hint={hint}
        fit="field"
        control={<ChoicePicker label={label} shape={shape} />}
        status={host.status}
        actions={actions}
        mark={host.mark}
        note={host.note}
      />
    </Banded>
  );
}

/**
 * A single-select too long to be rows: the box the value is picked FROM
 * (`ControlPanel.Field`), opening a panel whose rows are the options in the
 * panel's own radio language — never a native `<select>`, whose list is drawn by
 * the platform and agrees with nothing else on screen.
 *
 * Where that panel goes is the HOST's answer, exactly as it is for a `Group`: a
 * popover pushes a stack entry (one box, one width, one set of rails at every
 * depth, rather than a popover opened from inside a popover), and a pane — which
 * would lose the reader their place if editing one field of fifteen replaced the
 * whole body — opens a popover of its own.
 */
function ChoicePicker({
  label,
  shape,
}: {
  label: React.ReactNode;
  shape: ChoiceShape;
}) {
  const host = useControlPanelHost();
  const stack = usePanelStack();
  const entryKey = useId();
  const [open, setOpen] = useState(false);

  const current = shape.options.find((o) => o.value === shape.value[0]);
  const title = typeof label === "string" ? label : "";

  const rows = (done: () => void) => (
    <ControlPanel.Section>
      {shape.options.map((option) => (
        <ControlPanel.Row
          key={option.value}
          select="radio"
          checked={option.value === shape.value[0]}
          hint={option.hint}
          onSelect={() => {
            shape.onSelect(option.value);
            done();
          }}
        >
          {option.label}
        </ControlPanel.Row>
      ))}
    </ControlPanel.Section>
  );

  const trigger = (
    <ControlPanel.Field icon={current?.icon} label={summaryOf(current)} />
  );

  if (host.nesting === "push") {
    return (
      <ControlPanel.Field
        icon={current?.icon}
        label={summaryOf(current)}
        onClick={() =>
          stack.push({
            key: entryKey,
            title,
            render: () => rows(stack.pop),
          })
        }
      />
    );
  }

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      label={title}
    >
      {rows(() => setOpen(false))}
    </ControlPanelPopover>
  );
}

/** `null` — not `""` — so the `Field` shows its muted placeholder for "unset". */
function summaryOf(option: ChoiceOption | undefined): React.ReactNode {
  return option?.label ?? null;
}

function GroupFields({ shape }: { shape: GroupShape }) {
  return (
    <>
      {Object.entries(shape.fields).map(([key, subField]) => (
        <FieldRenderer
          key={key}
          field={subField}
          value={shape.values[key]}
          onChange={(value) => shape.onChangeField(key, value)}
        />
      ))}
    </>
  );
}

/**
 * A list is a `Group` whose children are its items, and each item is whatever
 * ITS own shape says — so a list of records and a list of scalars are one code
 * path here, and `string-list` stops being its own layout.
 *
 * NOTE — `onMove` is carried by the shape and is NOT rendered yet: no member of
 * the vocabulary exposes a drag handle on a `Setting` or a `Group` (only
 * `ControlPanel.Row` has one), so there is nowhere honest to hang the gesture.
 * Adding it is a change to the primitive, not to this file.
 */
function ListMember({
  label,
  hint,
  description,
  adornments,
  actions,
  shape,
}: {
  label: React.ReactNode;
  hint?: string;
  description?: React.ReactNode;
  adornments?: ConfigFieldAdornments | null;
  actions?: React.ReactNode;
  shape: ListShape;
}) {
  const host = adornments ?? NO_ADORNMENTS;
  return (
    <ControlPanel.Group
      label={label}
      hint={hint}
      description={description}
      status={host.status}
      actions={actions}
      mark={host.mark}
      note={host.note}
    >
      {shape.items.map((item, index) => (
        <ListItemMember
          key={item.id}
          item={item}
          index={index}
          onRemove={shape.onRemove}
        />
      ))}
      {shape.onAdd ? (
        // A ROW, not a `Footer`: a footer is a band, so one inside a group would
        // draw a hairline through the middle of it — and invariant #4's leading
        // footer glyph would open the icon column for every row in the PANEL.
        <ControlPanel.Row muted onSelect={shape.onAdd}>
          {shape.addLabel ?? "Add item"}
        </ControlPanel.Row>
      ) : null}
    </ControlPanel.Group>
  );
}

function ListItemMember({
  item,
  index,
  onRemove,
}: {
  item: ListShape["items"][number];
  index: number;
  onRemove?: (id: string) => void;
}) {
  const label = itemLabel(item.shape, index);

  if (item.shape.kind === "group") {
    // A `Group`'s drill row is a `<button>` under a pushing host, so an action
    // on its header is not universally spellable. Removal is therefore a member
    // the group CONTAINS.
    const groupShape = item.shape;
    return (
      <ControlPanel.Group label={label}>
        <GroupFields shape={groupShape} />
        {onRemove ? (
          <ControlPanel.Row
            tone="danger"
            muted
            onSelect={() => onRemove(item.id)}
          >
            Remove
          </ControlPanel.Row>
        ) : null}
      </ControlPanel.Group>
    );
  }

  return (
    <ShapeMember
      label={label}
      shape={item.shape}
      actions={
        onRemove ? (
          <IconButton
            icon={closeIcon}
            label="Remove"
            onClick={() => onRemove(item.id)}
          />
        ) : undefined
      }
    />
  );
}

/**
 * What names one row of a list. A record names itself with its first non-empty
 * text value — the summary a reader recognises — and everything else falls back
 * to its position, which is the only other honest answer for an ordered list.
 */
function itemLabel(shape: FieldShape, index: number): string {
  const fallback = `Item ${index + 1}`;
  if (shape.kind !== "group") return fallback;
  // The DECLARED fields are the authority on what an item has, and they are read
  // in declaration order — never `Object.values(shape.values)`. A stored item
  // record carries keys no field record ever declared: a `ListItem`'s synthetic
  // `id`, and a legacy `rank` on documents written before array position became
  // the order. `id` is first in insertion order, so reading the value object
  // directly labelled EVERY list of records in the app with a UUID.
  for (const key of Object.keys(shape.fields)) {
    const value = shape.values[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return fallback;
}
