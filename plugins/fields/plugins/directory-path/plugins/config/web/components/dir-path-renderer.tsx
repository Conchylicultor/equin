import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import { directoryPathFieldType } from "@plugins/fields/plugins/directory-path/core";
import { FolderPickerPopover } from "@plugins/primitives/plugins/folder-picker/web";

const DirPathRenderer = defineFieldShape({
  type: directoryPathFieldType,
  useShape: ({ field, value, onChange }) => ({
    kind: "value",
    fit: "field",
    control: (
      <FolderPickerPopover
        purpose="edit"
        key={value}
        value={value}
        onChange={onChange}
        placeholder={field.meta.placeholder}
      />
    ),
  }),
});

export { DirPathRenderer };
