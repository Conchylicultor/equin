import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  parseHostServiceDeclarations,
  type HostServiceDecl,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// The host services a module declares (`defineHostService`), as the per-file
// scan a host graph's derivation keeps as file records: a module's
// declarations are a function of its bytes, so a derivation after an edit
// reads only the edited modules of the graph's reach — never all ~1.2k.

export const HOST_SERVICE_DECLS_SCAN: FileScan<HostServiceDecl[]> = {
  url: import.meta.url,
  scan: (src) =>
    src.includes("defineHostService") ? parseHostServiceDeclarations(src) : [],
};
