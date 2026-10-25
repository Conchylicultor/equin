import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  sendEmail,
  type ResendEmail,
  type ResendSendResult,
} from "./internal/send-email";

export default {
  description:
    "Stateless Resend client: sendEmail(apiKey, email) makes one POST to Resend's emails API (from, to, reply-to, subject, plain text) and answers { ok: true, id } or { ok: false, status, error } with Resend's own words — no answer at all throws. Takes the key per call; never touches auth or storage.",
} satisfies ServerPluginDefinition;
