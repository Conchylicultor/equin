import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { join } from "path";
import { createLintToolkit } from "../class-token-walk";
import { readDeclaredUtilities } from "../declared-utilities";

// The toolkit `buildLintConfig` hands every class-rule factory, built over this
// checkout's real app.css, so a rule's test constructs the rule exactly as the
// lint config does. The root is this file's location, eight folders down.
export const lintToolkit = createLintToolkit(
  readDeclaredUtilities(
    asAppPath(join(import.meta.dir, "../../../../../../../..")),
  ),
);
