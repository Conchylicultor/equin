/**
 * The site-messages mirror set's id: what the deploy app copies from a
 * deployed site's box (`apps/deploy/site-mirror`) to read its inbox locally.
 * `site_messages` without `ip_hash`; the salt never leaves the box.
 */
export const SITE_MESSAGES_MIRROR_SET_ID = "site_messages";
