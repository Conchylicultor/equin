import { type FieldDef, type FieldMeta, pickMeta } from "@plugins/fields/core";
import { directoryPathFieldType } from "@plugins/fields/plugins/directory-path/core";
import {
  UserPathSchema,
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

export interface DirPathFieldDef extends FieldDef<UserPath> {
  readonly type: typeof directoryPathFieldType;
}

/**
 * A config field for an absolute host directory path. Rendered as a folder
 * picker (typeable input + browse popover). The value is a `UserPath`: the
 * user chose it, so it may sit in a folder macOS asks permission for, and the
 * `user-path/no-sync-fs` lint keeps a synchronous fs call off it in backend
 * code. The schema is otherwise a plain string: existence is advisory UI
 * feedback, not a hard save gate, so empty/in-progress values and
 * default-backfill never break.
 */
export function dirPathField(
  opts?: FieldMeta & { default?: string },
): DirPathFieldDef {
  return Object.freeze({
    type: directoryPathFieldType,
    schema: UserPathSchema,
    defaultValue: asUserPath(opts?.default ?? ""),
    meta: pickMeta(opts),
  });
}
