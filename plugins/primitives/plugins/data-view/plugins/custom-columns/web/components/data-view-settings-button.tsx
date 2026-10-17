import { useMemo, useState, type ReactNode } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { FieldIdentity, FieldsRecord } from "@plugins/fields/core";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  getDataViewDescriptor,
  useDataViewControls,
  useResolveColumnConfig,
  useFieldIdentities,
  type DataViewId,
} from "@plugins/primitives/plugins/data-view/web";
import type { CustomColumnDef } from "../../core";
import { useCustomColumnDefs } from "../internal/use-custom-column-defs";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const deleteIcon = symbol("delete");

/** Default new-column field type — the string-valued baseline that needs no config. */
const DEFAULT_TYPE = "text";

/** One `customColumn`-eligible field type, ready for the picker (id + icon + label). */
interface TypeOption {
  id: string;
  label: string;
  icon?: FieldIdentity["icon"];
}

/** Identities opted into custom columns, as picker options (icon + label). */
function useCustomColumnTypeOptions(): TypeOption[] {
  const identities = useFieldIdentities();
  return useMemo(
    () =>
      [...identities.values()]
        .filter((i) => i.customColumn)
        .map((i) => ({
          id: i.type.id,
          label: i.label ?? i.type.id,
          icon: i.icon,
        })),
    [identities],
  );
}

/** A type option's icon as an element, or nothing when the identity has none. */
function typeIcon(option: TypeOption | undefined): ReactNode {
  const icon = option?.icon;
  return icon ? <Icon icon={icon} /> : undefined;
}

/**
 * The **Fields** section of the DataView settings panel: one row per custom
 * column, plus a `New field` row. Editing a column and creating one each open a
 * PAGE of their own.
 *
 * That is the whole change. This surface used to cram a type `Select`, a name
 * `Input` and an `Add` button onto one line, with every existing column an
 * inline rename input beside a delete button — three controls competing for the
 * width of a 256px menu, and a third "on" language stacked under Properties'
 * checkboxes and Group by's checkmarks. A row that says what the column IS, and
 * a page that edits it, needs no width at all.
 *
 * The pages are pushed through `usePanelStack()`, which this section reaches
 * through CONTEXT — it is a nested contribution inside data-view's settings
 * panel and has no prop path back to whichever chrome is hosting it.
 */
export function CustomColumnsFields({
  defs,
}: {
  defs: CustomColumnDef[];
}): ReactNode {
  const typeOptions = useCustomColumnTypeOptions();

  const typeOf = (id: string) => typeOptions.find((o) => o.id === id);

  return (
    <ControlPanel.Section label="Fields">
      {defs.map((def) => {
        const option = typeOf(def.type);
        return (
          <ControlPanel.Row
            key={def.id}
            icon={typeIcon(option)}
            trailing={option?.label ?? def.type}
            push={{
              key: `custom-column:${def.id}`,
              title: def.label,
              render: () => <CustomColumnPanel columnId={def.id} />,
            }}
          >
            {def.label}
          </ControlPanel.Row>
        );
      })}
      <ControlPanel.Row
        icon={<Icon icon={addIcon} />}
        muted
        push={{
          key: "custom-column:new",
          title: "New field",
          render: () => <CustomColumnPanel columnId={null} />,
        }}
      >
        New field
      </ControlPanel.Row>
    </ControlPanel.Section>
  );
}

/**
 * A pushed column page — the editor for `columnId`, or the create form when it is
 * null.
 *
 * It re-resolves the descriptor and the definitions controller itself rather than
 * capturing them: a panel-stack entry's `render` closure is captured when the row
 * is clicked, so a `def` passed in would still be the one from before the rename
 * the page itself just made. The descriptor gate mirrors
 * `CustomColumnsFieldsSetting`'s — the hook lives past it, in an inner component,
 * so it is never called conditionally.
 */
function CustomColumnPanel({
  columnId,
}: {
  columnId: string | null;
}): ReactNode {
  const { storageKey } = useDataViewControls();
  const descriptor = getDataViewDescriptor(storageKey);
  if (!descriptor) return null;
  return (
    <CustomColumnPanelBody
      descriptor={descriptor}
      storageKey={storageKey}
      columnId={columnId}
    />
  );
}

function CustomColumnPanelBody({
  descriptor,
  storageKey,
  columnId,
}: {
  descriptor: ConfigDescriptor<FieldsRecord>;
  storageKey: DataViewId;
  columnId: string | null;
}): ReactNode {
  const { defs, ...actions } = useCustomColumnDefs(descriptor, storageKey);
  const { pop } = usePanelStack();

  if (columnId === null) {
    return (
      <NewColumnForm
        onCreate={(label, type) => {
          actions.addColumn(label, type);
          pop();
        }}
      />
    );
  }

  // Deleted while its page was open (or by another tab) — the page has nothing
  // left to edit, and popping is the honest answer.
  const def = defs.find((d) => d.id === columnId);
  if (!def) return null;

  return (
    <ColumnEditor
      def={def}
      onRename={actions.renameColumn}
      onSetConfig={actions.setColumnConfig}
      onDelete={(id) => {
        pop();
        actions.deleteColumn(id);
      }}
    />
  );
}

/**
 * The create page: pick a type, name it, create it. The type is a radio SET and
 * not a dropdown — it is a short closed list, this is the only place it is ever
 * chosen (a column's type is immutable after creation), and a select inside a
 * panel is a third selection language beside the panel's own two.
 */
function NewColumnForm({
  onCreate,
}: {
  onCreate: (label: string, type: string) => void;
}): ReactNode {
  const typeOptions = useCustomColumnTypeOptions();
  const [name, setName] = useState("");
  const [type, setType] = useState<string>(DEFAULT_TYPE);

  const submit = () => {
    const label = name.trim();
    if (label === "") return;
    onCreate(label, type);
  };

  return (
    <>
      <ControlPanel.Section label="Name">
        <Input
          autoFocus
          value={name}
          placeholder="Field name…"
          aria-label="New column name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </ControlPanel.Section>
      <ControlPanel.Section label="Type">
        {typeOptions.map((option) => (
          <ControlPanel.Row
            key={option.id}
            select="radio"
            checked={type === option.id}
            trailing={typeIcon(option)}
            onSelect={() => setType(option.id)}
          >
            {option.label}
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={addIcon} />}
          disabled={name.trim() === ""}
          onSelect={submit}
        >
          Create field
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </>
  );
}

/**
 * The edit page: rename, the type as a read-only statement, the type's own
 * config editor when it contributes one, and a destructive footer row.
 *
 * The name input is UNCONTROLLED, keyed by `def.label` so an external rename
 * resets the draft without a sync effect; an empty commit reverts to the current
 * label.
 */
function ColumnEditor({
  def,
  onRename,
  onSetConfig,
  onDelete,
}: {
  def: CustomColumnDef;
  onRename: (id: string, label: string) => void;
  onSetConfig: (id: string, config: unknown) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const typeOptions = useCustomColumnTypeOptions();
  const option = typeOptions.find((o) => o.id === def.type);
  const configEditor = useResolveColumnConfig()(def.type, {
    config: def.config,
    onChange: (next) => onSetConfig(def.id, next),
  });

  const commit = (el: HTMLInputElement) => {
    const next = el.value.trim();
    if (next === "") {
      el.value = def.label;
      return;
    }
    if (next !== def.label) onRename(def.id, next);
  };

  return (
    <>
      <ControlPanel.Section label="Name">
        <Input
          key={def.label}
          defaultValue={def.label}
          aria-label={`Rename column ${def.label}`}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </ControlPanel.Section>

      {/* A statement, not a control: the type is immutable after creation, and
          the page saying so is clearer than the picker simply being absent. */}
      <ControlPanel.Section label="Type">
        <ControlPanel.Row icon={typeIcon(option)} muted>
          {option?.label ?? def.type}
        </ControlPanel.Row>
      </ControlPanel.Section>

      {configEditor ? (
        <ControlPanel.Section label="Options">
          {configEditor}
        </ControlPanel.Section>
      ) : null}

      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={deleteIcon} />}
          tone="danger"
          onSelect={() => onDelete(def.id)}
        >
          Delete column
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </>
  );
}
