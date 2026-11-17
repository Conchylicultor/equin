import { defineNotice } from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";

/**
 * The refusal a person reads when they run equin as root — on a server, the
 * deploy path's default account. It follows the installer message rules
 * (`infra/launcher/installer-notice`): built at load, so a rule break fails
 * its test before anyone reads it.
 */
export const RUN_AS_ROOT = defineNotice({
  title: "equin cannot run as root, the administrator account",
  doing:
    "equin was starting its own database, where it keeps your tasks, pages and settings.",
  blocked:
    "That database refuses to run as root for safety, so equin cannot start under that account.",
  now: [
    "Sign in as an ordinary account and run the same command again.",
    "On a server, create one with `adduser --disabled-password --gecos '' equin`, give it the folder equin is in with `chown -R equin:equin <equin folder>`, then switch to it with `su - equin` and run the same command again.",
  ],
  ifSkipped: {
    optional: false,
    because:
      "that database is where equin keeps everything, so equin cannot start without it.",
  },
  evidence: [
    "uid 0 (root)",
    "Postgres' initdb refuses to run as the root OS user, so the embedded cluster and every backend behind it cannot start",
  ],
});
