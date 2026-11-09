import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import { directoryPathFieldType } from "@plugins/fields/plugins/directory-path/core";
import { FolderPickerPopover } from "@plugins/primitives/plugins/folder-picker/web";
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const DirPathRenderer = defineFieldShape({
  type: directoryPathFieldType,
  useShape: ({ field, value, onChange }) => ({
    kind: "value",
    fit: "field",
    control: (
      <FolderPickerPopover
        // A directory-path setting is a folder of the computer's disk (a
        // `UserPath`), read there by whoever reads the setting.
        fs="computer"
        purpose="edit"
        key={value}
        value={value}
        onChange={(path) => onChange(asUserPath(path))}
        placeholder={field.meta.placeholder}
      />
    ),
  }),
});

export { DirPathRenderer };
