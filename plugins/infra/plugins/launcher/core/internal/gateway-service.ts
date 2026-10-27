import type { LoginServiceId } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import {
  LEGACY_IDS,
  PRODUCT_NAME,
} from "@plugins/framework/plugins/product-name/core";

/**
 * The gateway as a per-user OS service — what makes the app come back after a
 * reboot and relaunches the gateway when it dies. One login service among
 * those `./equin start` brings up (`launcher/login-services`), but not a
 * declared one: it is the service every other one needs, `start` gates on it
 * answering, hands over a gateway started outside the manager, and builds its
 * launch from flags (`--log-level`, the bind host). So `start` drives it by
 * this id and job explicitly, through the same `LoginService` a declared
 * service gets.
 *
 * `background`: it runs with nobody at the screen (systemd: at boot, given
 * lingering), and its rendered plist / unit is exactly the pre-generic one.
 *
 * In `core` because what the menu-bar helper's job carries (the label its
 * Start button kicks) is read from it too, and a login-services declaration
 * may not import `server`.
 *
 * Its label is `dev.equin.gateway`, but an install not yet migrated has it
 * under the old label, and the service stays bound to that one
 * (`installedAs`) until `./equin data-dir migrate` relabels it. Read the label
 * a command acts on from the bound service (`service.id.label`), never from
 * here.
 */
export const GATEWAY_SERVICE: LoginServiceId = {
  label: `dev.${PRODUCT_NAME}.gateway`,
  session: "background",
  installedAs: [LEGACY_IDS.launchdLabel],
};
