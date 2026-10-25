import { machineHost, runOk, type CodesignHost } from "./host";

/** LaunchServices' registration tool: not on PATH, only at its framework path. */
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * Register the app bundle at `bundle` with LaunchServices (`lsregister -f`),
 * which is what lets macOS resolve its bundle id: `tccutil reset <Service>
 * <bundle id>` answers "No such bundle identifier" for a bundle LaunchServices
 * does not know, and System Settings cannot name or draw it. A bundle under a
 * temporary directory (`/tmp`) registers as `launch-disabled` and stays
 * unresolvable — keep one under the data root. Idempotent; nothing off macOS.
 */
export async function registerApp(
  bundle: string,
  host: CodesignHost = machineHost(),
): Promise<void> {
  if (host.platform !== "darwin") return;
  await runOk(host, [LSREGISTER, "-f", bundle]);
}
