import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { resolvedFileServed } from "./internal/resolve-value";

export default {
  description:
    "file-resolve's desktop half: the code.resolve-file live value — where a requested path resolves in a checkout (an exact file, a bounded list of fuzzy git ls-files matches with their total, or not found), pushed from the checkout watch and a watch of the path's own entry while read.",
  contributions: [...resolvedFileServed.declare],
} satisfies MachinePluginDefinition;
