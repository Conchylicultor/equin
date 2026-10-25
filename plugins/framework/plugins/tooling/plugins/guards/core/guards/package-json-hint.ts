import { PLUGIN_MANIFEST_KEY } from "@plugins/framework/plugins/plugin-id/core";
import { fileHint } from "../file-hint";

export const packageJsonHint = fileHint({
  name: "package-json-own-ns",
  match: (p) => p.endsWith("/package.json"),
  message: `Reminder: equin metadata goes under the "${PLUGIN_MANIFEST_KEY}" key, not at the root level. Exception: "description" is a standard npm field and belongs at the root.`,
});
