import {
  defineMirrorSet,
  MirrorSet,
  NeverMirrored,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { SITE_MESSAGES_MIRROR_SET_ID } from "../../core";
import { siteMessages, siteMessagesSalt } from "./tables";

/**
 * The `site_messages` mirror set: what the deploy app copies from a deployed
 * site's box (`apps/deploy/site-mirror`) so its inbox reads every message
 * locally. The notify and confirm jobs' updates reach the copy as changes,
 * the spam sweep's deletes as tombstones. The salted IP hash stays on the box.
 */
export const siteMessagesMirror = defineMirrorSet({
  id: SITE_MESSAGES_MIRROR_SET_ID,
  tables: [siteMessages],
  omit: [siteMessages.ipHash],
});

export const siteMessagesMirrorContributions = [
  MirrorSet(siteMessagesMirror),
  NeverMirrored({
    tables: [siteMessagesSalt],
    reason:
      "the install's salt is what makes a visitor's ip_hash reproducible from their IP; it never leaves the box",
  }),
];
