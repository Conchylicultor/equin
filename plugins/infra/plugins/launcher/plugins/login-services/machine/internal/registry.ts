import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { loginServicesEntries } from "../../core/login-services.generated";
import {
  isLoginServiceDeclaration,
  type LoginServiceDeclaration,
} from "./define";

/**
 * Every declared login service: each plugin's `login-services/index.ts` default
 * export (an array of `defineLoginService` values), collected by codegen into
 * `core/login-services.generated.ts`. Known statically, so `./equin start` /
 * `stop` read it without booting a backend — and name no service.
 */
let loaded: Promise<LoginServiceDeclaration[]> | undefined;

export function declaredLoginServices(): Promise<LoginServiceDeclaration[]> {
  return (loaded ??= loadDeclared());
}

async function loadDeclared(): Promise<LoginServiceDeclaration[]> {
  // Strict: a declaration that fails to load, or a default export that is not
  // one, must be loud — a quietly skipped service would read as "nothing to
  // start" and simply never come up.
  const decls = await loadCollectedDir<LoginServiceDeclaration>(
    loginServicesEntries,
    { isItem: isLoginServiceDeclaration, strict: true, label: "login service" },
  );
  const byId = new Map<string, LoginServiceDeclaration>();
  for (const decl of decls) {
    const other = byId.get(decl.id);
    if (other !== undefined && other !== decl) {
      throw new Error(
        `Two login services are declared with id ${JSON.stringify(decl.id)} (owners ${other.owner} and ${decl.owner}). ` +
          "An id is a launchd label and a systemd unit name, so it must be unique.",
      );
    }
    byId.set(decl.id, decl);
  }
  return [...byId.values()];
}
