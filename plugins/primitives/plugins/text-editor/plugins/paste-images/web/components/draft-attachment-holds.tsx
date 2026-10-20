import { useEffect } from "react";
import { holdAttachments } from "@plugins/infra/plugins/attachments/web";
import {
  legacyDraftKeys,
  onDraftWritten,
  readDraft,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { extractAttachmentIds } from "../internal/markdown";

// A hold already sent is re-sent at most this often while its set is unchanged,
// so an edited draft keeps pushing its expiry forward. Added to the hold's
// length, so the hold never lapses before the draft it mirrors.
const REFRESH_MS = 60 * 60 * 1000;

const clientIdStore = defineStore({
  owner: "paste-images.client-id",
  label: "Browser ids",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.string(),
  legacy: legacyDraftKeys("paste-images:client-id"),
});

/** This browser's id, so two browsers drafting under one key hold apart. */
function clientId(): string {
  const stored = readDraft(clientIdStore);
  if (stored) return stored;
  const id = crypto.randomUUID();
  writeDraft(clientIdStore, id);
  return id;
}

/**
 * Headless (`Core.Root`): an attachment pasted into a draft is uploaded at once
 * but linked to its owner only when the draft is sent, and the server's orphan
 * sweep reclaims unlinked uploads after an hour. Drafts live in browser storage
 * the server cannot see, so every draft write re-asserts, as a server-side hold,
 * exactly the attachments the draft references, for as long as the draft lives.
 * A clear (or an edit that drops an image) releases them.
 */
export function DraftAttachmentHolds(): null {
  useEffect(() => {
    const sent = new Map<string, { ids: string; at: number }>();
    return onDraftWritten(({ storageKey, value, ttl }) => {
      const ids =
        value === undefined
          ? []
          : extractAttachmentIds(JSON.stringify(value)).sort();
      const signature = ids.join(" ");
      const prev = sent.get(storageKey);
      const now = Date.now();
      if (prev === undefined && ids.length === 0) return;
      if (prev?.ids === signature && now - prev.at < REFRESH_MS) return;
      if (ids.length === 0) sent.delete(storageKey);
      else sent.set(storageKey, { ids: signature, at: now });
      void holdAttachments(
        `${clientId()}:${storageKey}`,
        ids,
        Number.isFinite(ttl) ? ttl + REFRESH_MS : null,
      );
    });
  }, []);
  return null;
}
