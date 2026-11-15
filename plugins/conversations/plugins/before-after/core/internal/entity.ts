import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { attachmentLinkFields } from "@plugins/infra/plugins/attachments/core";
import { baIdKind } from "./id-kind";

/** The colour schemes a capture can be taken in — a closed list. */
export const BEFORE_AFTER_COLOR_SCHEMES = ["light", "dark"] as const;
export type BeforeAfterColorScheme =
  (typeof BEFORE_AFTER_COLOR_SCHEMES)[number];

/**
 * A before / after pair's fields, in column order (`before_after_pairs`). One
 * row per `register_before_after` call: two images of one screen — by default
 * main vs this conversation's build — and what was compared.
 *
 * - `toolUseId` — the agent's tool call that registered it (the transcript row
 *   the call renders as, which reads the pair back by it); `null` when the MCP
 *   client did not name its call.
 * - `route` / `colorScheme` — what was captured; `null` for a pair registered
 *   from two PNG files (the agent made the images; nothing says how).
 * - `width` / `height` — the images' size in pixels (the capture viewport, or
 *   the before file's own size).
 * - `beforeAttachmentId` / `afterAttachmentId` — the PNGs (`infra/attachments`,
 *   served as `GET /api/attachments/:id`), kept alive by this table's link set
 *   (`before_after_pairs_attachments`).
 * - `beforeLabel` / `afterLabel` — what each side is ("main" / "this build" for
 *   a capture).
 */
export const beforeAfterPairFields = {
  id: idKindField(baIdKind),
  conversationId: textField({ label: "Conversation" }),
  toolUseId: nullable(textField({ label: "Tool call" })),
  title: textField({ label: "Title", primary: true }),
  route: nullable(textField({ label: "Route" })),
  width: intField({ label: "Width" }),
  height: intField({ label: "Height" }),
  colorScheme: nullable(
    enumTextField(BEFORE_AFTER_COLOR_SCHEMES, { label: "Color scheme" }),
  ),
  beforeAttachmentId: textField({ label: "Before image" }),
  afterAttachmentId: textField({ label: "After image" }),
  beforeLabel: textField({ label: "Before" }),
  afterLabel: textField({ label: "After" }),
  createdAt: dateField({ label: "Created" }),
} satisfies FieldsRecord;

/** The `before_after_pairs` entity. */
export const beforeAfterPairsEntityRef = entityRef(
  "before_after_pairs",
  beforeAfterPairFields,
);

/** The `before_after_pairs_attachments` link entity — its table built by `Attachments.defineLink`. */
export const beforeAfterPairAttachmentLinksEntityRef = entityRef(
  "before_after_pairs_attachments",
  attachmentLinkFields,
);
