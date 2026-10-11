import { type ReactNode, useMemo } from "react";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { variantField } from "@plugins/fields/plugins/variant/plugins/config/core";
import { iconField } from "@plugins/fields/plugins/icon/plugins/config/core";
import { FieldRenderer } from "@plugins/config_v2/plugins/fields/web";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import type { ViewTypeMeta } from "../../core";
import type { ResolvedViewInstance } from "../internal/resolve-instances";
import type { ViewActionsCore } from "../internal/use-view-model";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const contentCopyIcon = symbol("content-copy");
const deleteIcon = symbol("delete");
// The same field the config row declares, so the panel and the Settings pane
// draw one picker.
const viewIconField = iconField({ label: "Icon" });

/**
 * Settings panel for the active instance — opened by clicking the active chip.
 * A `Name` section, an `Icon` picker (unset = the view-type's own glyph), the
 * type-dispatched options sub-form (over a web-side
 * `variantField`), and a footer of Duplicate / Delete.
 *
 * It is written in the `control-panel` vocabulary, which is the sibling
 * primitive: the sections are separated by the panel container rather than by
 * spacing chosen here, and the two actions are full-width rows rather than an
 * outline button beside a destructive ghost one. view-core imports the primitive
 * and nothing else — it must never import data-view, which sits above it.
 *
 * The `viewField` is built **web-side at render** with the registry the panel
 * asks the model for ITSELF (`actions.variantsFor(id)` — the instance's own
 * source, gated exactly like the `+` add menu), so the type selector + each
 * type's `configSchema` sub-fields recurse through `FieldRenderer`. Asking
 * rather than being handed a map is the point: a caller cannot pass a registry
 * that belongs to a different instance, or an ungated one listing types this
 * surface cannot render — which is what silently emptied a switcher when a flat
 * surface was offered the tree. The stored descriptor stays server-safe (no
 * `useVariants`). `updateView(id, v, { merge: true })` shallow-merges over the
 * raw view, preserving any host-injected keys (sort/filter) the sub-form omits.
 */
export function ViewSettingsPopover<T extends ViewTypeMeta>({
  instance,
  actions,
  onClose,
}: {
  instance: ResolvedViewInstance<T>;
  actions: ViewActionsCore;
  onClose: () => void;
}): ReactNode {
  const id = instance.instance.id;

  const viewVariants = actions.variantsFor(id);
  const viewField = useMemo(
    () => variantField({ label: "View", useVariants: () => viewVariants }),
    [viewVariants],
  );

  // The stored variant value `{ type, ...options }`. Resolved instance carries it
  // as the opaque `options` (set by buildInstanceFromRow). Fall back to a bare
  // `{ type }` for a synthesized (not-yet-materialized) default.
  const view = (instance.instance.options as VariantValue | undefined) ?? {
    type: instance.instance.type,
  };

  return (
    <>
      <ControlPanel.Section label="Name">
        <Input
          defaultValue={instance.instance.name}
          aria-label="View name"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== instance.instance.name)
              actions.renameView(id, next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </ControlPanel.Section>

      <ControlPanel.Section>
        <FieldRenderer
          field={viewIconField}
          value={instance.instance.pickedIcon}
          onChange={(icon) =>
            actions.setViewIcon(id, icon as SavedSymbolName | null)
          }
        />
      </ControlPanel.Section>

      <ControlPanel.Section>
        <FieldRenderer
          field={viewField}
          value={view}
          onChange={(v) =>
            actions.updateView(id, v as VariantValue, { merge: true })
          }
        />
      </ControlPanel.Section>

      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={contentCopyIcon} />}
          onSelect={() => {
            actions.duplicateView(id);
            onClose();
          }}
        >
          Duplicate
        </ControlPanel.Row>
        <ControlPanel.Row
          icon={<Icon icon={deleteIcon} />}
          tone="danger"
          onSelect={() => {
            actions.deleteView(id);
            onClose();
          }}
        >
          Delete
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </>
  );
}
