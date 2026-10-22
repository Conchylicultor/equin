import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  MessageBodyState,
  type ReadyMailMessageBody,
} from "./components/message-body-state";

export default {
  description:
    "MessageBodyState: one message's mail.message-body value with its loading and failed-fetch (Retry) states drawn once, for every pane that shows a body.",
} satisfies PluginDefinition;
