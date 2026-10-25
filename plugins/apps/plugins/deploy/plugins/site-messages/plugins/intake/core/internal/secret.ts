import { defineDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/core";

/**
 * The Resend API key the box sends notification emails with. Unset (a dev
 * worktree, or a box it was never approved for) → every message is stored
 * with `notify_state: not-configured` and nothing is sent.
 */
export const RESEND_API_KEY = defineDeploySecret({
  key: "RESEND_API_KEY",
  description:
    "Resend API key the site uses to email you each message a visitor sends through its contact form.",
});
