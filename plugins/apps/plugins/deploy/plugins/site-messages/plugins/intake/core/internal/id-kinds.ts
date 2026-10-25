import { defineIdKind, type IdOf } from "@plugins/ids/core";

/** One message a visitor sent through a deployed site (`site_messages.id`). */
export const siteMessageIdKind = defineIdKind({
  prefix: "smsg",
  label: "Site message",
});

export type SiteMessageId = IdOf<typeof siteMessageIdKind>;
