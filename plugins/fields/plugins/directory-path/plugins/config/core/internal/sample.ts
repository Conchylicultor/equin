import { fieldSample } from "@plugins/config_v2/plugins/fields/core";
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { dirPathField } from "./directory-path";

/**
 * The directory-path field's fixed gallery sample (see `FieldSample`). `/tmp`
 * exists on every macOS and Linux host, so the picker's existence check always
 * answers the same way.
 */
export const dirPathSample = fieldSample(
  dirPathField({
    label: "Scratch directory",
    description: "Where agents write temporary files.",
  }),
  asUserPath("/tmp"),
);
