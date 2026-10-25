import noLaunderedCheckoutNamespace from "./no-laundered-checkout-namespace";

export default {
  name: "namespace-identity",
  rules: {
    "no-laundered-checkout-namespace": noLaunderedCheckoutNamespace,
  },
  /**
   * Enforced in test and e2e files, which contributed rules are otherwise off in
   * (see lint/core/non-app-globs.ts). Both conditions that exemption rests on
   * fail here:
   *
   *   - This is not an architecture rule. A wrong namespace is a wrong app: it
   *     names another deploy's URL, database, config directory and log files,
   *     and the process reads and writes them without complaint. The run then
   *     reports success, which is the whole failure mode — an e2e script that
   *     resolved main's origin from a worktree printed `ALL CHECKS PASSED`
   *     while reverting the user's live config documents on main.
   *   - The remedy is reachable from the files it fires on. `namespaceFor` and
   *     `asNamespace` live in @plugins/infra/plugins/namespace/core, and
   *     `resolveCheckoutDeploy` in @plugins/infra/plugins/paths/core — `core`
   *     barrels, which the `e2e` runtime may import. The usual reason to switch
   *     a rule off in a driver (it points at a `web` primitive `e2e` may not
   *     reach) does not apply.
   *
   * And the decisive one: the defect that motivated the rule was written in
   * `e2e-harness/e2e/target.ts`, a file NON_APP_FILE_GLOBS would have switched
   * the rule off in. A rule that is off in the file its own bug lived in is not
   * enforcing anything.
   */
  enforceEverywhere: ["no-laundered-checkout-namespace"],
};
