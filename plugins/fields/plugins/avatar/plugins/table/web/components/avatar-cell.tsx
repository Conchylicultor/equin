import type { ReactNode } from "react";
import type { AvatarSpec } from "@plugins/fields/plugins/avatar/core";
import type { AvatarShape } from "@plugins/primitives/plugins/avatar/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import type {
  FieldDef,
  TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";

/** An avatar cell's `data` payload. `fallbackKey`, `shape` and `symbol` are
 *  render-time only: `fallbackKey` seeds the derived colour when `color` is
 *  null, `shape` picks the outline (an app icon is a squircle; people and
 *  agents stay circles), and `symbol` is a glyph named in code (an app's icon)
 *  drawn when there is no saved `icon` — none is part of the persisted
 *  {@link AvatarSpec}. */
export type AvatarFieldData = AvatarSpec & {
  fallbackKey?: string;
  shape?: AvatarShape;
  symbol?: IconRef;
};

/** Thrown when an avatar cell's `data` is not an {@link AvatarFieldData}. */
export class AvatarCellDataError extends Error {
  constructor(field: FieldDef<unknown>, data: unknown) {
    super(
      `avatar cell: field "${field.id}" projected \`data\` that is not an AvatarFieldData (got ${data === null ? "null" : typeof data})`,
    );
    this.name = "AvatarCellDataError";
  }
}

function isNullOr(v: unknown, check: (v: unknown) => boolean): boolean {
  return v === null || check(v);
}

function isAvatarFieldData(data: unknown): data is AvatarFieldData {
  if (typeof data !== "object" || data === null) return false;
  if (!("icon" in data && "color" in data)) return false;
  const isString = (v: unknown) => typeof v === "string";
  const isShape = (v: unknown) => v === "circle" || v === "squircle";
  return (
    isNullOr(data.icon, isString) &&
    isNullOr(data.color, isString) &&
    (!("fallbackKey" in data) ||
      data.fallbackKey === undefined ||
      isString(data.fallbackKey)) &&
    (!("shape" in data) || data.shape === undefined || isShape(data.shape)) &&
    (!("symbol" in data) ||
      data.symbol === undefined ||
      (typeof data.symbol === "object" &&
        data.symbol !== null &&
        "kind" in data.symbol &&
        "name" in data.symbol))
  );
}

/** Read-only avatar cell: an icon + colour disc drawn from the field's `data`. */
export function AvatarCell(props: TableCellProps): ReactNode {
  const { data } = props;
  if (!isAvatarFieldData(data))
    throw new AvatarCellDataError(props.field, data);
  return (
    <Avatar
      icon={data.icon}
      color={data.color}
      symbol={data.symbol}
      fallbackKey={data.fallbackKey}
      shape={data.shape}
    />
  );
}

export interface AvatarFieldDefOptions<TRow> {
  id: string;
  label: string;
  /** The row's avatar — becomes the field's `data` projection. */
  avatar: (row: TRow) => AvatarFieldData;
  visible?: boolean;
}

/**
 * The one typed spelling for an avatar DataView field: `type: "avatar"` with
 * `avatar` wired as `data`, so a wrong payload is a type error here rather than
 * an {@link AvatarCellDataError} at render. Not the config_v2 `avatarField`
 * factory in `fields/avatar/plugins/config`.
 */
export function avatarFieldDef<TRow>(
  def: AvatarFieldDefOptions<TRow>,
): FieldDef<TRow> {
  return {
    id: def.id,
    label: def.label,
    type: "avatar",
    data: def.avatar,
    ...(def.visible !== undefined && { visible: def.visible }),
  };
}
