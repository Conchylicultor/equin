import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

import { createLintToolkit } from "../class-token-walk";
import { readDeclaredUtilities } from "../declared-utilities";

// The toolkit `buildLintConfig` hands every class-rule factory, built over this
// checkout's real app.css, so a rule's test constructs the rule exactly as the
// lint config does.
export const lintToolkit = createLintToolkit(readDeclaredUtilities(REPO_ROOT));
